using System;
using System.Collections;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;
using System.Security.Principal;
using System.Security.Cryptography;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BOLAuto.BolPageProbe
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ProbeForm(Options.Parse(args)));
            }
            catch (Exception ex)
            {
                Environment.ExitCode = 1;
                try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launch-error.log"), DateTime.UtcNow.ToString("o") + " " + ex.GetType().Name + " " + ex.Message + Environment.NewLine, Encoding.UTF8); } catch { }
                throw;
            }
        }
    }

    internal sealed class Options
    {
        public string Profile, AuditPath, InitialUrl, Proxy, ProxyBypass, BridgeRoot, ExpectedProductId;
        public string RecoveryPreviousFailedOperationId, RecoveryEvidenceRef;
        public static bool IsBolUrl(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" &&
                (uri.Host.Equals("bol.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".bol.com", StringComparison.OrdinalIgnoreCase));
        }
        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == "--profile") o.Profile = Path.GetFullPath(args[++i]);
                else if (args[i] == "--audit") o.AuditPath = Path.GetFullPath(args[++i]);
                else if (args[i] == "--url") o.InitialUrl = args[++i];
                else if (args[i] == "--proxy") o.Proxy = args[++i];
                else if (args[i] == "--proxy-bypass") o.ProxyBypass = args[++i];
                else if (args[i] == "--bridge-root") o.BridgeRoot = Path.GetFullPath(args[++i]);
                else if (args[i] == "--expected-product-id") o.ExpectedProductId = args[++i];
                else if (args[i] == "--recovery-previous-failed-operation") o.RecoveryPreviousFailedOperationId = args[++i];
                else if (args[i] == "--recovery-evidence-ref") o.RecoveryEvidenceRef = args[++i];
            }
            if (String.IsNullOrWhiteSpace(o.Profile) || String.IsNullOrWhiteSpace(o.AuditPath)) throw new InvalidOperationException("Isolated profile and audit path are required.");
            if (String.IsNullOrWhiteSpace(o.BridgeRoot)) throw new InvalidOperationException("Bridge root is required.");
            string isolatedRoot = Path.GetDirectoryName(Path.GetFullPath(o.Profile)).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string bridgeFull = Path.GetFullPath(o.BridgeRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string auditFull = Path.GetFullPath(o.AuditPath);
            if (!String.Equals(Path.GetFileName(isolatedRoot.TrimEnd(Path.DirectorySeparatorChar)), "BOL_PAGE_PROBE_BROWSER", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Probe profile must stay under the isolated BOL page probe root.");
            if (!bridgeFull.StartsWith(isolatedRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Bridge must stay under the isolated BOL page probe root.");
            if (!auditFull.StartsWith(isolatedRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Audit must stay under the isolated BOL page probe root.");
            if (!IsBolUrl(o.InitialUrl)) throw new InvalidOperationException("Initial navigation is restricted to HTTPS bol.com.");
            if (String.IsNullOrWhiteSpace(o.RecoveryPreviousFailedOperationId) != String.IsNullOrWhiteSpace(o.RecoveryEvidenceRef))
                throw new InvalidOperationException("NAVIGATION_RECOVERY_EVIDENCE_INVALID");
            if (!String.IsNullOrWhiteSpace(o.ExpectedProductId) && !Regex.IsMatch(o.ExpectedProductId, "^\\d{8,16}$")) throw new InvalidOperationException("Expected product ID is invalid.");
            if (!String.IsNullOrEmpty(o.Proxy))
            {
                Uri parsed;
                if (!Uri.TryCreate(o.Proxy, UriKind.Absolute, out parsed) || (parsed.Scheme != "http" && parsed.Scheme != "https") || String.IsNullOrEmpty(parsed.Host) || parsed.UserInfo.Length != 0 || parsed.Query.Length != 0 || parsed.Fragment.Length != 0)
                    throw new InvalidOperationException("Proxy configuration is invalid.");
            }
            return o;
        }
    }

    internal sealed class ProbeForm : Form
    {
        private readonly Options options;
        private readonly WebView2 browser = new WebView2();
        private readonly TextBox address = new TextBox();
        private readonly TextBox output = new TextBox();
        private readonly Label status = new Label();
        private readonly object auditLock = new object();
        private readonly object networkLock = new object();
        private readonly List<Dictionary<string, object>> networkMetadata = new List<Dictionary<string, object>>();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 512 * 1024 };
        private readonly Timer bridgeTimer = new Timer();
        private readonly NavigationFailureGate navigationFailureGate = new NavigationFailureGate();
        private TaskCompletionSource<Dictionary<string, object>> navigationCompletion;
        private readonly Dictionary<string, Dictionary<string, object>> devtoolsRequests = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        private Dictionary<string, object> lastDocumentNetworkFailure;
        private DateTime navigationStartedUtc;
        private string expectedProductId;
        private string activeNavigationOperationId;
        private string activeNavigationUrl;
        private int activeNavigationAttemptNumber;
        private bool domBusy;
        private bool bridgeBusy;

        public ProbeForm(Options options)
        {
            this.options = options;
            expectedProductId = options.ExpectedProductId ?? "";
            Text = "BOL 商品页只读探针 · 独立 WebView2 Profile";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1100, 720);
            Size = new Size(1500, 960);
            BuildUi();
            Shown += async delegate { try { await InitializeBrowserAsync(); } catch (Exception ex) { WriteAudit("browser_init_error", ex.GetType().Name + ": " + ex.Message); SetStatus("WebView2 初始化失败 · " + ex.GetType().Name); } };
            FormClosed += delegate { bridgeTimer.Stop(); bridgeTimer.Dispose(); browser.Dispose(); };
            WriteAudit("process_start", "pid=" + Process.GetCurrentProcess().Id + "; user=" + WindowsIdentity.GetCurrent().Name + "; session=" + Process.GetCurrentProcess().SessionId + "; interactive=" + Environment.UserInteractive + "; profile=" + options.Profile + "; runtime=" + Environment.OSVersion.VersionString);
        }

        private void BuildUi()
        {
            var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 42, WrapContents = false, Padding = new Padding(4) };
            address.Width = 900;
            address.Text = options.InitialUrl;
            address.KeyDown += delegate(object s, KeyEventArgs e) { if (e.KeyCode == Keys.Enter) { Navigate(); e.SuppressKeyPress = true; } };
            bar.Controls.Add(address);
            bar.Controls.Add(MakeButton("打开", 64, delegate { Navigate(); }));
            bar.Controls.Add(MakeButton("读取 DOM", 86, async delegate { await InspectDomAsync(); }));
            bar.Controls.Add(MakeButton("展开只读内容", 112, async delegate { await ExpandReadOnlyAsync(); }));
            bar.Controls.Add(MakeButton("刷新", 64, delegate { Navigate(); }));
            status.Dock = DockStyle.Top;
            status.Height = 26;
            status.TextAlign = ContentAlignment.MiddleLeft;
            status.Text = "正在初始化独立浏览器…";
            var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, SplitterDistance = 590 };
            browser.Dock = DockStyle.Fill;
            split.Panel1.Controls.Add(browser);
            output.Dock = DockStyle.Fill;
            output.Multiline = true;
            output.ReadOnly = true;
            output.ScrollBars = ScrollBars.Both;
            output.WordWrap = false;
            output.Font = new Font("Consolas", 9);
            split.Panel2.Controls.Add(output);
            Controls.Add(split);
            Controls.Add(status);
            Controls.Add(bar);
            output.Text = "DOM 摘要与 Network/XHR 事件（仅记录脱敏元数据；不保存 Cookie、请求头或响应正文）。";
        }

        private static Button MakeButton(string text, int width, EventHandler handler)
        {
            var button = new Button { Text = text, Width = width, Height = 30, Margin = new Padding(3) };
            button.Click += handler;
            return button;
        }

        private async Task InitializeBrowserAsync()
        {
            WriteAudit("profile_prepare", "profile_path=" + options.Profile);
            Directory.CreateDirectory(options.Profile);
            Directory.CreateDirectory(Path.GetDirectoryName(options.AuditPath));
            var bridgeInbox = Path.Combine(options.BridgeRoot, "inbox");
            var bridgeOutbox = Path.Combine(options.BridgeRoot, "outbox");
            Directory.CreateDirectory(bridgeInbox);
            Directory.CreateDirectory(bridgeOutbox);
            var envOptions = new CoreWebView2EnvironmentOptions();
            envOptions.AdditionalBrowserArguments = "--proxy-server=\"" + options.Proxy + "\" --proxy-bypass-list=\"" + (options.ProxyBypass ?? "") + "\"";
            WriteAudit("environment_create_start", "route=PROXY; proxy_host=" + SafeHost(options.Proxy) + "; proxy_port=" + SafePort(options.Proxy) + "; bypass_rule_count=" + ((options.ProxyBypass ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Length));
            var environment = await CoreWebView2Environment.CreateAsync(null, options.Profile, envOptions);
            WriteAudit("environment_create_done", "runtime=" + environment.BrowserVersionString);
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            WriteAudit("core_ready", "source=" + (core == null ? "null" : "available"));
            const string networkObserver = "(function(){if(window.__bolProbeObserver)return;window.__bolProbeObserver=true;function emit(kind,method,url,status){try{var u=new URL(url,location.href);if(u.hostname==='bol.com'||u.hostname.endsWith('.bol.com'))window.chrome.webview.postMessage(JSON.stringify({kind:kind,method:method||'',host:u.hostname,path:u.pathname,status:status==null?null:status,time:new Date().toISOString()}));}catch(e){}}var oldFetch=window.fetch;if(oldFetch)window.fetch=function(){var a=arguments;var url=typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||'';var method=(a[1]&&a[1].method)||(a[0]&&a[0].method)||'GET';emit('fetch_start',method,url,null);return oldFetch.apply(this,a).then(function(r){emit('fetch_response',method,url,r.status);return r;},function(e){emit('fetch_error',method,url,null);throw e;});};var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__bolProbeMethod=m;this.__bolProbeUrl=u;return xo.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){var x=this;emit('xhr_start',x.__bolProbeMethod,x.__bolProbeUrl,null);x.addEventListener('loadend',function(){emit('xhr_response',x.__bolProbeMethod,x.__bolProbeUrl,x.status);});return xs.apply(this,arguments);};})();";
            WriteAudit("observer_install_start", "mode=fetch_xhr_metadata_after_navigation");
            core.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs e)
            {
                try
                {
                    string message = e.TryGetWebMessageAsString();
                    if (!String.IsNullOrEmpty(message))
                    {
                        AppendOutput(DateTime.UtcNow.ToString("o") + "  NET " + message);
                        WriteAudit("network_observer", message);
                    }
                }
                catch { }
            };
            await InstallNetworkDiagnosticsAsync(core);
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = true;
            core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                if (!Options.IsBolUrl(e.Uri)) { e.Cancel = true; SetStatus("已阻止非 bol.com 页面导航"); WriteAudit("navigation_blocked", "host=" + SafeHost(e.Uri)); return; }
                if (navigationFailureGate.ObserveNavigationStarting(e.Uri))
                {
                    e.Cancel = true;
                    SetStatus("上次导航失败；需提供明确恢复证据后才能再次打开该页面");
                    WriteAudit("navigation_retry_blocked", "error_code=NAVIGATION_RECOVERY_EVIDENCE_REQUIRED; failed_operation_id=" +
                        (navigationFailureGate.FailedOperationIdFor(e.Uri) ?? "unknown") + "; url=" + SanitizeUrl(e.Uri));
                    return;
                }
                navigationStartedUtc = DateTime.UtcNow;
                lastDocumentNetworkFailure = null;
                SetStatus("正在打开 " + SafeHost(e.Uri));
                WriteAudit("navigation_starting", "route=PROXY; proxy_host=" + SafeHost(options.Proxy) + "; proxy_port=" + SafePort(options.Proxy) + "; url=" + SanitizeUrl(e.Uri));
            };
            core.NavigationCompleted += async delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                SetStatus(e.IsSuccess ? "页面导航完成 · " + SafeHost(browser.Source == null ? "" : browser.Source.ToString()) : "页面导航失败 · " + e.WebErrorStatus);
                double elapsed = navigationStartedUtc == DateTime.MinValue ? -1 : Math.Max(0, (DateTime.UtcNow - navigationStartedUtc).TotalMilliseconds);
                string networkError = lastDocumentNetworkFailure == null ? "none" : Convert.ToString(lastDocumentNetworkFailure["error_code"]);
                WriteAudit("navigation_completed", "success=" + e.IsSuccess + "; web_error=" + e.WebErrorStatus + "; network_error=" + networkError + "; elapsed_ms=" + Math.Round(elapsed));
                string completedOperationId = activeNavigationOperationId;
                string completedUrl = activeNavigationUrl;
                int completedAttemptNumber = activeNavigationAttemptNumber;
                if (!String.IsNullOrWhiteSpace(completedOperationId))
                {
                    string gateError;
                    bool recorded = navigationFailureGate.Complete(completedOperationId, completedUrl, e.IsSuccess, out gateError);
                    WriteAudit("navigation_operation_completed", "operation_id=" + completedOperationId + "; attempt_no=" + completedAttemptNumber + "; success=" + e.IsSuccess + "; evidence_gate=" + (recorded ? "PASS" : gateError));
                    activeNavigationOperationId = null;
                    activeNavigationUrl = null;
                    activeNavigationAttemptNumber = 0;
                }
                if (navigationCompletion != null)
                {
                    var navResult = new Dictionary<string, object>();
                    navResult["success"] = e.IsSuccess;
                    navResult["operation_id"] = completedOperationId;
                    navResult["attempt_no"] = completedAttemptNumber;
                    navResult["web_error"] = e.WebErrorStatus.ToString();
                    navResult["url"] = browser.Source == null ? "" : SanitizeUrl(browser.Source.ToString());
                    navResult["http_status"] = LastStatusForPath(SafePath(browser.Source == null ? "" : browser.Source.ToString()));
                    navResult["elapsed_ms"] = Math.Round(elapsed);
                    navResult["network_failure"] = lastDocumentNetworkFailure == null ? null : new Dictionary<string, object>(lastDocumentNetworkFailure);
                    navigationCompletion.TrySetResult(navResult);
                    navigationCompletion = null;
                }
                if (!e.IsSuccess)
                {
                    try { core.Stop(); } catch { }
                }
                if (e.IsSuccess)
                {
                    try { await core.ExecuteScriptAsync(networkObserver); WriteAudit("observer_install_done", "in_document=true"); }
                    catch (Exception ex) { WriteAudit("observer_install_error", ex.GetType().Name + ": " + ex.Message); }
                    await InspectDomAsync();
                }
            };
            core.WebResourceResponseReceived += delegate(object s, CoreWebView2WebResourceResponseReceivedEventArgs e)
            {
                try
                {
                    Uri uri;
                    if (Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out uri) && IsBolHost(uri.ToString()))
                    {
                        string contentType = null;
                        try { contentType = e.Response == null ? null : e.Response.Headers.GetHeader("Content-Type"); } catch { }
                        var metadata = new Dictionary<string, object>();
                        metadata["time"] = DateTime.UtcNow.ToString("o");
                        metadata["host"] = uri.Host;
                        metadata["path"] = uri.AbsolutePath;
                        metadata["method"] = e.Request.Method;
                        metadata["status"] = e.Response == null ? (object)null : e.Response.StatusCode;
                        metadata["content_type"] = contentType;
                        metadata["query_parameter_names"] = GetQueryParameterNames(uri);
                        lock (networkLock)
                        {
                            networkMetadata.Add(metadata);
                            while (networkMetadata.Count > 100) networkMetadata.RemoveAt(0);
                        }
                        string item = DateTime.UtcNow.ToString("o") + "  RESPONSE " + e.Request.Method + " " + SafeHost(uri.ToString()) + SafePath(uri.ToString()) + " · HTTP " + (e.Response == null ? "?" : e.Response.StatusCode.ToString());
                        AppendOutput(item);
                        WriteAudit("network_response", "method=" + e.Request.Method + "; host=" + uri.Host + "; path=" + uri.AbsolutePath + "; status=" + (e.Response == null ? "unknown" : e.Response.StatusCode.ToString()));
                    }
                }
                catch { }
            };
            core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; WriteAudit("popup_blocked", "host=" + SafeHost(e.Uri)); };
            core.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs e) { WriteAudit("webview_process_failed", "kind=" + e.ProcessFailedKind + "; reason=" + e.Reason); };
            SetStatus("WebView2 已就绪 · runtime " + environment.BrowserVersionString + " · profile 独立");
            WriteAudit("webview_ready", "pid=" + Process.GetCurrentProcess().Id + "; runtime=" + environment.BrowserVersionString + "; profile=" + options.Profile);
            bridgeTimer.Interval = 200;
            bridgeTimer.Tick += async delegate { await PollBridgeAsync(); };
            bridgeTimer.Start();
            WriteAudit("file_bridge_ready", "root=" + options.BridgeRoot);
            string initialOperationId;
            int initialAttemptNumber;
            string initialGateError;
            if (!String.IsNullOrWhiteSpace(options.RecoveryPreviousFailedOperationId))
            {
                string seedError;
                if (!navigationFailureGate.SeedPriorFailure(options.InitialUrl, options.RecoveryPreviousFailedOperationId, options.RecoveryEvidenceRef, out seedError))
                {
                    WriteAudit("initial_recovery_evidence_rejected", "error_code=" + seedError);
                    SetStatus("恢复证据无效；已阻止初始页面导航");
                    return;
                }
            }
            if (BeginNavigationOperation(options.InitialUrl, "initial", options.RecoveryPreviousFailedOperationId, options.RecoveryEvidenceRef, out initialOperationId, out initialAttemptNumber, out initialGateError))
            {
                core.Navigate(options.InitialUrl);
            }
            else
            {
                WriteAudit("initial_navigation_blocked", "error_code=" + initialGateError);
            }
        }

        private async Task InstallNetworkDiagnosticsAsync(CoreWebView2 core)
        {
            try
            {
                var requestReceiver = core.GetDevToolsProtocolEventReceiver("Network.requestWillBeSent");
                requestReceiver.DevToolsProtocolEventReceived += delegate(object sender, CoreWebView2DevToolsProtocolEventReceivedEventArgs e) { RecordDevToolsRequest(e.ParameterObjectAsJson); };
                var responseReceiver = core.GetDevToolsProtocolEventReceiver("Network.responseReceived");
                responseReceiver.DevToolsProtocolEventReceived += delegate(object sender, CoreWebView2DevToolsProtocolEventReceivedEventArgs e) { RecordDevToolsResponse(e.ParameterObjectAsJson); };
                var failureReceiver = core.GetDevToolsProtocolEventReceiver("Network.loadingFailed");
                failureReceiver.DevToolsProtocolEventReceived += delegate(object sender, CoreWebView2DevToolsProtocolEventReceivedEventArgs e) { RecordDevToolsFailure(e.ParameterObjectAsJson); };
                await core.CallDevToolsProtocolMethodAsync("Network.enable", "{}");
                WriteAudit("network_diagnostics_ready", "source=devtools; events=request,response,loadingFailed; bodies_and_headers=not_collected");
            }
            catch (Exception ex)
            {
                WriteAudit("network_diagnostics_unavailable", "error_type=" + ex.GetType().Name);
            }
        }

        private void RecordDevToolsRequest(string raw)
        {
            try
            {
                var root = json.DeserializeObject(raw) as Dictionary<string, object>;
                var request = GetMap(root, "request");
                string id = GetMapString(root, "requestId");
                string url = GetMapString(request, "url");
                Uri uri;
                if (String.IsNullOrEmpty(id) || !Uri.TryCreate(url, UriKind.Absolute, out uri) || !IsBolHost(url)) return;
                var item = new Dictionary<string, object> {
                    { "request_id", id }, { "host", uri.Host }, { "path", uri.AbsolutePath },
                    { "method", GetMapString(request, "method") }, { "resource_type", GetMapString(root, "type") }
                };
                lock (networkLock) devtoolsRequests[id] = item;
                WriteAudit("network_request", "host=" + uri.Host + "; path=" + uri.AbsolutePath + "; method=" + item["method"] + "; resource_type=" + item["resource_type"]);
            }
            catch { WriteAudit("network_event_parse_error", "event=request"); }
        }

        private void RecordDevToolsResponse(string raw)
        {
            try
            {
                var root = json.DeserializeObject(raw) as Dictionary<string, object>;
                string id = GetMapString(root, "requestId");
                Dictionary<string, object> request;
                lock (networkLock) devtoolsRequests.TryGetValue(id, out request);
                if (request == null) return;
                var response = GetMap(root, "response");
                var uri = new Uri("https://" + Convert.ToString(request["host"]) + Convert.ToString(request["path"]));
                var metadata = new Dictionary<string, object> {
                    { "time", DateTime.UtcNow.ToString("o") }, { "host", request["host"] }, { "path", request["path"] },
                    { "method", request["method"] }, { "resource_type", request["resource_type"] },
                    { "status", GetMapValue(response, "status") }, { "content_type", GetMapString(response, "mimeType") },
                    { "remote_ip", SafeIp(GetMapString(response, "remoteIPAddress")) }, { "protocol", SafeProtocol(GetMapString(response, "protocol")) },
                    { "query_parameter_names", GetQueryParameterNames(uri) }
                };
                lock (networkLock) { networkMetadata.Add(metadata); TrimNetworkMetadata(); }
                WriteAudit("network_response", "host=" + request["host"] + "; path=" + request["path"] + "; method=" + request["method"] + "; status=" + Convert.ToString(metadata["status"]) + "; content_type=" + metadata["content_type"] + "; remote_ip=" + metadata["remote_ip"] + "; protocol=" + metadata["protocol"]);
            }
            catch { WriteAudit("network_event_parse_error", "event=response"); }
        }

        private void RecordDevToolsFailure(string raw)
        {
            try
            {
                var root = json.DeserializeObject(raw) as Dictionary<string, object>;
                string id = GetMapString(root, "requestId");
                Dictionary<string, object> request;
                lock (networkLock) devtoolsRequests.TryGetValue(id, out request);
                if (request == null) return;
                string errorCode = SafeNetworkError(GetMapString(root, "errorText"));
                bool canceled = String.Equals(GetMapString(root, "canceled"), "true", StringComparison.OrdinalIgnoreCase);
                string resourceType = Convert.ToString(request["resource_type"]);
                var failure = new Dictionary<string, object> {
                    { "time", DateTime.UtcNow.ToString("o") }, { "host", request["host"] }, { "path", request["path"] },
                    { "method", request["method"] }, { "resource_type", resourceType }, { "status", null },
                    { "content_type", null }, { "remote_ip", null }, { "protocol", null },
                    { "error_code", errorCode }, { "canceled", canceled }
                };
                if (String.Equals(resourceType, "Document", StringComparison.OrdinalIgnoreCase)) lastDocumentNetworkFailure = failure;
                lock (networkLock) { networkMetadata.Add(new Dictionary<string, object>(failure)); TrimNetworkMetadata(); }
                WriteAudit("network_loading_failed", "host=" + request["host"] + "; path=" + request["path"] + "; method=" + request["method"] + "; resource_type=" + resourceType + "; error_code=" + errorCode + "; canceled=" + canceled);
            }
            catch { WriteAudit("network_event_parse_error", "event=loadingFailed"); }
        }

        private static Dictionary<string, object> GetMap(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }

        private static object GetMapValue(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value : null;
        }

        private static string GetMapString(Dictionary<string, object> map, string key) { return Convert.ToString(GetMapValue(map, key) ?? ""); }
        private static string SafeNetworkError(string value)
        {
            string candidate = value ?? "";
            if (candidate.StartsWith("net::", StringComparison.OrdinalIgnoreCase)) candidate = candidate.Substring(5);
            return Regex.IsMatch(candidate, "^ERR_[A-Z0-9_]+$") ? candidate : (String.IsNullOrEmpty(candidate) ? "UNKNOWN" : "OTHER_NETWORK_ERROR");
        }
        private static string SafeProtocol(string value) { return Regex.IsMatch(value ?? "", "^(h[0-9.]+|http/1\\.[01]|unknown)$", RegexOptions.IgnoreCase) ? value : "unknown"; }
        private static string SafeIp(string value) { System.Net.IPAddress ip; return System.Net.IPAddress.TryParse(value, out ip) ? ip.ToString() : "unknown"; }
        private static string SafePort(string value) { Uri u; return Uri.TryCreate(value, UriKind.Absolute, out u) ? u.Port.ToString() : "unknown"; }
        private void TrimNetworkMetadata() { while (networkMetadata.Count > 100) networkMetadata.RemoveAt(0); }

        private async Task InspectDomAsync()
        {
            if (browser.CoreWebView2 == null || domBusy) return;
            domBusy = true;
            try
            {
            string script = "(function(){var t=(document.body&&document.body.innerText)||'',e=" + json.Serialize(expectedProductId) + ";var c=document.querySelector('link[rel=canonical]'),cu='';try{cu=c?new URL(c.href,location.href).origin+new URL(c.href,location.href).pathname:'';}catch(x){}var m=(cu||location.origin+location.pathname).match(/\\/(\\d{8,16})\\/?$/);var cid=m?m[1]:'';return JSON.stringify({url:location.origin+location.pathname,title:document.title||'',readyState:document.readyState,bodyTextLength:t.length,requested_product_id:e||null,canonical_product_id:cid||null,product_id_match:e?(cid?(e===cid?'true':'false'):'unknown'):'unknown',loginUiHeuristic:/inloggen|account|mijn bol/i.test(t.slice(0,5000)),cookieBannerVisible:/cookie|cookies/i.test(t.slice(0,2500)),cookieValuesRead:false,readAt:new Date().toISOString()});})()";
                string result = await browser.CoreWebView2.ExecuteScriptAsync(script);
                string decoded = Regex.Unescape(result.Trim('"'));
                AppendOutput(DateTime.UtcNow.ToString("o") + "  DOM " + decoded);
                WriteAudit("dom_snapshot", decoded);
                SetStatus("DOM 已读取 · " + browser.CoreWebView2.DocumentTitle + " · " + DateTime.Now.ToString("HH:mm:ss"));
            }
            catch (Exception ex) { WriteAudit("dom_read_error", ex.GetType().Name + ": " + ex.Message); SetStatus("DOM 读取失败 · " + ex.GetType().Name); }
            finally { domBusy = false; }
        }

        private async Task PollBridgeAsync()
        {
            if (bridgeBusy || IsDisposed || browser.CoreWebView2 == null) return;
            bridgeBusy = true;
            try
            {
                string inbox = Path.Combine(options.BridgeRoot, "inbox");
                string outbox = Path.Combine(options.BridgeRoot, "outbox");
                string[] files = Directory.GetFiles(inbox, "*.json");
                Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                if (files.Length == 0) return;
                string file = files[0];
                string id = Path.GetFileNameWithoutExtension(file);
                if (!Regex.IsMatch(id, "^[a-fA-F0-9-]{32,36}$")) { File.Delete(file); return; }
                Dictionary<string, object> response = new Dictionary<string, object>();
                response["id"] = id;
                response["ok"] = false;
                try
                {
                    var request = json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
                    File.Delete(file);
                    if (request == null) throw new InvalidOperationException("INVALID_COMMAND");
                    string command = GetString(request, "command").ToLowerInvariant();
                    var args = request.ContainsKey("args") ? request["args"] as Dictionary<string, object> : null;
                    response["result"] = await HandleBridgeCommandAsync(command, args);
                    response["ok"] = true;
                    WriteAudit("bridge_command", "command=" + command + "; id=" + id + "; ok=true");
                }
                catch (Exception ex)
                {
                    response["error_code"] = ex is InvalidOperationException ? ex.Message : ex.GetType().Name.ToUpperInvariant();
                    WriteAudit("bridge_command", "id=" + id + "; ok=false; error=" + response["error_code"]);
                }
                string responsePath = Path.Combine(outbox, id + ".json");
                string tempPath = responsePath + ".tmp";
                File.WriteAllText(tempPath, json.Serialize(response), new UTF8Encoding(false));
                if (File.Exists(responsePath)) File.Delete(responsePath);
                File.Move(tempPath, responsePath);
            }
            catch (Exception ex) { WriteAudit("bridge_poll_error", ex.GetType().Name); }
            finally { bridgeBusy = false; }
        }

        private async Task<object> HandleBridgeCommandAsync(string command, Dictionary<string, object> args)
        {
            switch (command)
            {
                case "status":
                    var state = await ExecuteJsonAsync("(function(){var c=document.querySelector('link[rel=canonical]'),u='';try{u=c?new URL(c.href,location.href).origin+new URL(c.href,location.href).pathname:'';}catch(x){}return JSON.stringify({url:location.origin+location.pathname,canonical_url:u||null,title:document.title||'',readyState:document.readyState});})()");
                    state["pid"] = Process.GetCurrentProcess().Id;
                    return state;
                case "navigate":
                    string target = GetString(args, "url");
                    if (!Options.IsBolUrl(target)) throw new InvalidOperationException("NAVIGATION_RESTRICTED_TO_HTTPS_BOL_COM");
                    string expected = GetString(args, "expected_product_id");
                    if (!String.IsNullOrWhiteSpace(expected) && !Regex.IsMatch(expected, "^\\d{8,16}$")) throw new InvalidOperationException("EXPECTED_PRODUCT_ID_INVALID");
                    string requestedOperationId = GetString(args, "operation_id");
                    if (String.IsNullOrWhiteSpace(requestedOperationId)) requestedOperationId = Guid.NewGuid().ToString("N");
                    string previousFailedOperationId = null;
                    string recoveryEvidenceRef = null;
                    object recoveryValue;
                    if (args != null && args.TryGetValue("recovery_evidence", out recoveryValue))
                    {
                        var recovery = recoveryValue as Dictionary<string, object>;
                        if (recovery == null) throw new InvalidOperationException("NAVIGATION_RECOVERY_EVIDENCE_INVALID");
                        previousFailedOperationId = GetString(recovery, "previous_failed_operation_id");
                        recoveryEvidenceRef = GetString(recovery, "evidence_ref");
                    }
                    expectedProductId = expected;
                    var pending = new TaskCompletionSource<Dictionary<string, object>>();
                    string operationId;
                    int attemptNumber;
                    string gateError;
                    if (!BeginNavigationOperation(target, "bridge", previousFailedOperationId, recoveryEvidenceRef, requestedOperationId, out operationId, out attemptNumber, out gateError))
                    {
                        throw new InvalidOperationException(gateError);
                    }
                    navigationCompletion = pending;
                    browser.CoreWebView2.Navigate(target);
                    var completed = await Task.WhenAny(pending.Task, Task.Delay(30000));
                    if (completed != pending.Task)
                    {
                        navigationCompletion = null;
                        CompleteNavigationTimeout(operationId, target, attemptNumber);
                        return new Dictionary<string, object> { { "success", false }, { "error_code", "NAVIGATION_TIMEOUT" }, { "operation_id", operationId }, { "attempt_no", attemptNumber } };
                    }
                    var nav = pending.Task.Result;
                    nav["title"] = browser.CoreWebView2.DocumentTitle;
                    var navIdentity = await ExecuteJsonAsync(DomSummaryScript(expectedProductId));
                    nav["requested_product_id"] = navIdentity.ContainsKey("requested_product_id") ? navIdentity["requested_product_id"] : null;
                    nav["canonical_url"] = navIdentity.ContainsKey("canonical_url") ? navIdentity["canonical_url"] : null;
                    nav["canonical_product_id"] = navIdentity.ContainsKey("canonical_product_id") ? navIdentity["canonical_product_id"] : null;
                    nav["product_id_match"] = navIdentity.ContainsKey("product_id_match") ? navIdentity["product_id_match"] : "unknown";
                    return nav;
                case "get_dom_snapshot":
                    return await ExecuteJsonAsync(DomSummaryScript(expectedProductId));
                case "get_page_data":
                    string pageExpected = GetString(args, "expected_product_id");
                    if (!String.IsNullOrWhiteSpace(pageExpected))
                    {
                        if (!Regex.IsMatch(pageExpected, "^\\d{8,16}$")) throw new InvalidOperationException("EXPECTED_PRODUCT_ID_INVALID");
                        expectedProductId = pageExpected;
                    }
                    return await CollectPageDataAsync(expectedProductId);
                case "query_selector":
                    return await QuerySelectorAsync(args);
                case "find_text":
                    return await FindTextAsync(args);
                case "click_readonly":
                    return await ClickReadonlyAsync(args);
                case "scroll":
                    return await ScrollAsync(args);
                case "get_network_metadata":
                    lock (networkLock) return networkMetadata.Select(item => new Dictionary<string, object>(item)).ToList();
                default:
                    throw new InvalidOperationException("UNSUPPORTED_COMMAND");
            }
        }

        private async Task<Dictionary<string, object>> ExecuteJsonAsync(string script)
        {
            string raw = await browser.CoreWebView2.ExecuteScriptAsync(script);
            object decoded = json.DeserializeObject(raw);
            string inner = decoded as string;
            var result = inner == null ? decoded as Dictionary<string, object> : json.DeserializeObject(inner) as Dictionary<string, object>;
            return result ?? new Dictionary<string, object> { { "value", decoded } };
        }

        private async Task<object> CollectPageDataAsync(string requestedProductId)
        {
            if (browser.CoreWebView2 == null) throw new InvalidOperationException("WEBVIEW_NOT_READY");
            string contractPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bol_page_data_contract.js");
            if (!File.Exists(contractPath)) throw new InvalidOperationException("PAGE_DATA_CONTRACT_SCRIPT_MISSING");
            string script = File.ReadAllText(contractPath, Encoding.UTF8).Replace("__EXPECTED_PRODUCT_ID__", json.Serialize(requestedProductId ?? ""));
            return RedactObject(await ExecuteJsonAsync(script));
        }

        private string DomSummaryScript(string requestedProductId)
        {
            return "(function(){var b=document.body,t=(b&&b.innerText)||'',expected=" + json.Serialize(requestedProductId ?? "") + ";var vis=function(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};var ds=Array.prototype.slice.call(document.querySelectorAll('[role=dialog],[aria-modal=true],dialog,[class*=cookie i],[id*=cookie i]'));var cm=ds.some(function(e){return vis(e)&&/cookie|cookies|privacy|privacyvoorkeur/i.test(e.innerText||e.getAttribute('aria-label')||'')});var hs=Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).filter(vis).slice(0,12).map(function(e){return (e.innerText||'').trim().slice(0,180)});var c=document.querySelector('link[rel=canonical]'),cu='';try{cu=c?new URL(c.href,location.href).origin+new URL(c.href,location.href).pathname:'';}catch(x){}var m=(cu||location.origin+location.pathname).match(/\\/(\\d{8,16})\\/?$/),cid=m?m[1]:'';return JSON.stringify({url:location.origin+location.pathname,canonical_url:cu||null,title:document.title||'',readyState:document.readyState,bodyTextLength:t.length,requested_product_id:expected||null,canonical_product_id:cid||null,product_id_match:expected?(cid?(expected===cid?'true':'false'):'unknown'):'unknown',headings:hs,cookieModalDetected:cm,cookieValuesRead:false});})()";
        }

        private async Task<object> QuerySelectorAsync(Dictionary<string, object> args)
        {
            string selector = GetString(args, "selector");
            if (String.IsNullOrWhiteSpace(selector) || selector.Length > 500) throw new InvalidOperationException("INVALID_SELECTOR");
            string mode = GetString(args, "mode").ToLowerInvariant();
            string attribute = GetString(args, "attribute").ToLowerInvariant();
            if (mode != "text" && mode != "content" && mode != "attribute") mode = "text";
            if (mode == "attribute" && !new[] { "aria-label", "title", "role", "alt", "href", "src", "data-testid" }.Contains(attribute)) throw new InvalidOperationException("ATTRIBUTE_NOT_ALLOWED");
            string script = "(function(){var s=" + json.Serialize(selector) + ",m=" + json.Serialize(mode) + ",a=" + json.Serialize(attribute) + ";var es=Array.prototype.slice.call(document.querySelectorAll(s)),out=[];for(var i=0;i<es.length&&i<10;i++){var e=es[i],v='';if(m==='attribute'){v=e.getAttribute(a)||'';if(a==='href'||a==='src'){try{var u=new URL(v,location.href);v=u.origin+u.pathname;}catch(e){v='';}}}else{v=m==='content'?(e.textContent||''):(e.innerText||e.textContent||'');}out.push({tag:e.tagName.toLowerCase(),value:String(v).trim().slice(0,240)});}return JSON.stringify({selector:s,mode:m,attribute:a,count:es.length,items:out});})()";
            return RedactObject(await ExecuteJsonAsync(script));
        }

        private async Task<object> FindTextAsync(Dictionary<string, object> args)
        {
            string term = GetString(args, "text");
            if (String.IsNullOrWhiteSpace(term) || term.Length > 120) throw new InvalidOperationException("INVALID_SEARCH_TEXT");
            string script = "(function(){var q=" + json.Serialize(term) + ",t=(document.body&&document.body.innerText)||'',lo=t.toLowerCase(),at=0,hits=[];while(hits.length<5&&(at=lo.indexOf(q.toLowerCase(),at))>=0){hits.push(t.slice(Math.max(0,at-90),Math.min(t.length,at+q.length+130)));at+=Math.max(1,q.length);}return JSON.stringify({found:hits.length>0,count:hits.length,snippets:hits});})()";
            return RedactObject(await ExecuteJsonAsync(script));
        }

        private async Task<object> ClickReadonlyAsync(Dictionary<string, object> args)
        {
            string label = GetString(args, "text");
            if (String.IsNullOrWhiteSpace(label) || label.Length > 100 || !Regex.IsMatch(label, "(meer|toon|lees|bekijk|reviews|beoordelingen|specificaties|uitklappen|expand|show)", RegexOptions.IgnoreCase) || Regex.IsMatch(label, "(bestel|winkelwagen|toevoegen|inloggen|login|verwijder|betaal|kopen|submit|plaatsen)", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("CLICK_NOT_IN_READONLY_ALLOWLIST");
            string script = "(function(){var q=" + json.Serialize(label) + ",es=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],summary,a')),hit=null;for(var i=0;i<es.length;i++){var e=es[i],s=(e.innerText||e.getAttribute('aria-label')||'').trim(),r=e.getBoundingClientRect(),cs=getComputedStyle(e);if(!s||s.toLowerCase().indexOf(q.toLowerCase())<0||e.disabled||e.getAttribute('aria-expanded')==='true'||e.closest('form')||r.width===0||r.height===0||cs.display==='none'||cs.visibility==='hidden')continue;if(e.tagName==='A'){var u;try{u=new URL(e.href,location.href)}catch(x){continue;}if(u.hostname!=='bol.com'&&!u.hostname.endsWith('.bol.com'))continue;if(!/(review|beoordeling|specificatie|meer)/i.test(u.pathname+u.hash))continue;}hit={el:e,label:s,tag:e.tagName.toLowerCase()};break;}if(!hit)return JSON.stringify({clicked:false,reason:'NO_SAFE_MATCH'});hit.el.click();return JSON.stringify({clicked:true,label:hit.label.slice(0,120),tag:hit.tag});})()";
            object result = RedactObject(await ExecuteJsonAsync(script));
            await Task.Delay(900);
            return result;
        }

        private async Task<object> ScrollAsync(Dictionary<string, object> args)
        {
            string direction = GetString(args, "direction").ToLowerInvariant();
            if (direction != "up" && direction != "down") throw new InvalidOperationException("INVALID_SCROLL_DIRECTION");
            int amount = 700;
            object raw;
            if (args != null && args.TryGetValue("pixels", out raw)) Int32.TryParse(Convert.ToString(raw), out amount);
            amount = Math.Max(100, Math.Min(1200, amount));
            int delta = direction == "down" ? amount : -amount;
            string script = "(function(){window.scrollBy(0," + delta.ToString() + ");return JSON.stringify({x:window.scrollX,y:window.scrollY,viewportHeight:window.innerHeight,documentHeight:document.documentElement.scrollHeight});})()";
            var result = await ExecuteJsonAsync(script);
            await Task.Delay(900);
            return result;
        }

        private object RedactObject(object value)
        {
            if (value is Dictionary<string, object>)
            {
                var d = (Dictionary<string, object>)value;
                foreach (string key in d.Keys.ToList()) d[key] = RedactObject(d[key]);
                return d;
            }
            if (value is IList)
            {
                return ((IList)value).Cast<object>().Select(item => RedactObject(item)).ToArray();
            }
            if (value is string)
            {
                string text = (string)value;
                text = Regex.Replace(text, "(?i)\\bBearer\\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]");
                text = Regex.Replace(text, "(?i)(access[_-]?token|refresh[_-]?token|authorization|cookie)\\s*[:=]\\s*[^\\s,;]+", "$1=[REDACTED]");
                return text.Length > 500 ? text.Substring(0, 500) : text;
            }
            return value;
        }

        private static string GetString(Dictionary<string, object> values, string name)
        {
            if (values == null || !values.ContainsKey(name) || values[name] == null) return "";
            return Convert.ToString(values[name]);
        }

        private object LastStatusForPath(string path)
        {
            lock (networkLock)
            {
                var item = networkMetadata.LastOrDefault(x => String.Equals(Convert.ToString(x["path"]), path, StringComparison.OrdinalIgnoreCase) && String.Equals(Convert.ToString(x["method"]), "GET", StringComparison.OrdinalIgnoreCase));
                return item == null ? null : item["status"];
            }
        }

        private static List<string> GetQueryParameterNames(Uri uri)
        {
            var names = new List<string>();
            foreach (string part in (uri.Query ?? "").TrimStart('?').Split('&'))
            {
                if (String.IsNullOrEmpty(part)) continue;
                string key = Uri.UnescapeDataString(part.Split('=')[0]);
                if (!String.IsNullOrWhiteSpace(key) && !names.Contains(key)) names.Add(key);
                if (names.Count >= 20) break;
            }
            return names;
        }

        private async Task ExpandReadOnlyAsync()
        {
            if (browser.CoreWebView2 == null) return;
            const string script = "(function(){var re=/(meer|toon|lees meer|bekijk alle|reviews|beoordelingen|specificaties)/i;var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],summary,a'));var clicked=[];for(var i=0;i<nodes.length&&clicked.length<8;i++){var n=nodes[i];var s=(n.innerText||n.getAttribute('aria-label')||'').trim();if(!s||!re.test(s)||/bestel|winkelwagen|toevoegen|inloggen|verwijder|betaal|kopen/i.test(s))continue;if(n.disabled||n.getAttribute('aria-expanded')==='true')continue;try{n.click();clicked.push(s.slice(0,100));}catch(e){}}return JSON.stringify({clicked:clicked,visibleCandidateCount:nodes.length,readOnly:true});})()";
            try
            {
                string result = await browser.CoreWebView2.ExecuteScriptAsync(script);
                string decoded = Regex.Unescape(result.Trim('"'));
                AppendOutput(DateTime.UtcNow.ToString("o") + "  EXPAND " + decoded);
                WriteAudit("readonly_expand", decoded);
                await Task.Delay(1200);
                await InspectDomAsync();
            }
            catch (Exception ex) { WriteAudit("readonly_expand_error", ex.GetType().Name + ": " + ex.Message); }
        }

        private void Navigate()
        {
            string target = address.Text.Trim();
            if (!Options.IsBolUrl(target)) { SetStatus("仅允许 HTTPS bol.com 页面"); return; }
            if (browser.CoreWebView2 == null) { SetStatus("WebView2 尚未就绪"); return; }
            string operationId;
            int attemptNumber;
            string gateError;
            if (!BeginNavigationOperation(target, "desktop", null, null, out operationId, out attemptNumber, out gateError))
            {
                SetStatus("该页面上次导航失败；需要明确恢复证据后才能再次打开");
                return;
            }
            browser.CoreWebView2.Navigate(target);
        }

        private bool BeginNavigationOperation(
            string target,
            string source,
            string previousFailedOperationId,
            string recoveryEvidenceRef,
            out string operationId,
            out int attemptNumber,
            out string errorCode)
        {
            return BeginNavigationOperation(target, source, previousFailedOperationId, recoveryEvidenceRef,
                Guid.NewGuid().ToString("N"), out operationId, out attemptNumber, out errorCode);
        }

        private bool BeginNavigationOperation(
            string target,
            string source,
            string previousFailedOperationId,
            string recoveryEvidenceRef,
            string requestedOperationId,
            out string operationId,
            out int attemptNumber,
            out string errorCode)
        {
            operationId = requestedOperationId;
            if (!navigationFailureGate.TryBegin(target, requestedOperationId, previousFailedOperationId, recoveryEvidenceRef,
                out attemptNumber, out errorCode))
            {
                WriteAudit("navigation_operation_blocked", "operation_id=" + requestedOperationId + "; error_code=" + errorCode + "; source=" + source);
                return false;
            }
            activeNavigationOperationId = operationId;
            activeNavigationUrl = target;
            activeNavigationAttemptNumber = attemptNumber;
            string recoveryDetail = String.IsNullOrWhiteSpace(recoveryEvidenceRef)
                ? "recovery_evidence=false"
                : "recovery_evidence=true; previous_failed_operation_id=" + previousFailedOperationId +
                  "; evidence_ref_sha256=" + HashEvidenceRef(recoveryEvidenceRef);
            WriteAudit("navigation_operation_started", "operation_id=" + operationId + "; attempt_no=" + attemptNumber +
                "; source=" + source + "; " + recoveryDetail);
            return true;
        }

        private static string HashEvidenceRef(string value)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(value ?? ""));
                return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
            }
        }

        private void CompleteNavigationTimeout(string operationId, string target, int attemptNumber)
        {
            string gateError;
            bool recorded = navigationFailureGate.Complete(operationId, target, false, out gateError);
            if (String.Equals(activeNavigationOperationId, operationId, StringComparison.OrdinalIgnoreCase))
            {
                activeNavigationOperationId = null;
                activeNavigationUrl = null;
                activeNavigationAttemptNumber = 0;
            }
            WriteAudit("navigation_operation_completed", "operation_id=" + operationId + "; attempt_no=" + attemptNumber +
                "; success=false; error_code=NAVIGATION_TIMEOUT; evidence_gate=" + (recorded ? "PASS" : gateError));
            try { if (browser.CoreWebView2 != null) browser.CoreWebView2.Stop(); } catch { }
        }

        private void AppendOutput(string line)
        {
            if (output.IsDisposed) return;
            if (output.InvokeRequired) { try { output.BeginInvoke(new Action<string>(AppendOutput), line); } catch { } return; }
            output.AppendText(Environment.NewLine + line);
        }

        private void SetStatus(string value)
        {
            if (status.IsDisposed) return;
            if (status.InvokeRequired) { try { status.BeginInvoke(new Action<string>(SetStatus), value); } catch { } return; }
            status.Text = value;
        }

        private void WriteAudit(string kind, string detail)
        {
            string safe = "{\"time\":\"" + DateTime.UtcNow.ToString("o") + "\",\"kind\":\"" + Escape(kind) + "\",\"detail\":\"" + Escape(detail) + "\"}" + Environment.NewLine;
            try { lock (auditLock) File.AppendAllText(options.AuditPath, safe, Encoding.UTF8); } catch { }
        }
        private static string Escape(string value) { return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " "); }
        private static bool IsBolHost(string value) { return Options.IsBolUrl(value); }
        private static string SafeHost(string value) { Uri u; return Uri.TryCreate(value, UriKind.Absolute, out u) ? u.Host : "unknown"; }
        private static string SafePath(string value) { Uri u; return Uri.TryCreate(value, UriKind.Absolute, out u) ? u.AbsolutePath : "/"; }
        private static string SanitizeUrl(string value) { return SafeHost(value) + SafePath(value); }
    }
}
