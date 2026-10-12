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
        public string Profile, AuditPath, InitialUrl, Proxy, ProxyBypass, BridgeRoot, RuntimeManifestPath, ExpectedAsin;
        public static bool IsAmazonUrl(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" &&
                (uri.Host.Equals("amazon.de", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".amazon.de", StringComparison.OrdinalIgnoreCase));
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
                else if (args[i] == "--runtime-manifest") o.RuntimeManifestPath = Path.GetFullPath(args[++i]);
                else if (args[i] == "--expected-asin") o.ExpectedAsin = args[++i];
            }
            if (String.IsNullOrWhiteSpace(o.Profile) || String.IsNullOrWhiteSpace(o.AuditPath)) throw new InvalidOperationException("Isolated profile and audit path are required.");
            if (String.IsNullOrWhiteSpace(o.BridgeRoot)) throw new InvalidOperationException("Bridge root is required.");
            if (String.IsNullOrWhiteSpace(o.RuntimeManifestPath)) throw new InvalidOperationException("Runtime manifest path is required.");
            string isolatedRoot = Path.GetDirectoryName(Path.GetFullPath(o.Profile)).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string bridgeFull = Path.GetFullPath(o.BridgeRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string auditFull = Path.GetFullPath(o.AuditPath);
            string manifestFull = Path.GetFullPath(o.RuntimeManifestPath);
            if (!String.Equals(Path.GetFileName(isolatedRoot.TrimEnd(Path.DirectorySeparatorChar)), "AMAZON_PAGE_PROBE_BROWSER", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Probe profile must stay under the isolated Amazon page probe root.");
            if (!bridgeFull.StartsWith(isolatedRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Bridge must stay under the isolated Amazon page probe root.");
            if (!auditFull.StartsWith(isolatedRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Audit must stay under the isolated Amazon page probe root.");
            if (!manifestFull.StartsWith(isolatedRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Runtime manifest must stay under the isolated Amazon page probe root.");
            if (!IsAmazonUrl(o.InitialUrl)) throw new InvalidOperationException("Initial navigation is restricted to HTTPS amazon.de.");
            if (!String.IsNullOrWhiteSpace(o.ExpectedAsin) && !Regex.IsMatch(o.ExpectedAsin, "^[A-Z0-9]{10}$", RegexOptions.IgnoreCase)) throw new InvalidOperationException("Expected ASIN is invalid.");
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
        private readonly Timer heartbeatTimer = new Timer();
        private readonly object manifestLock = new object();
        private TaskCompletionSource<Dictionary<string, object>> navigationCompletion;
        private string expectedAsin;
        private bool domBusy;
        private bool bridgeBusy;
        private bool webViewInitialized;
        private bool bridgeWorkerStarted;
        private string bridgeWorkerHeartbeatAt;
        private string lastBridgeWorkerError;
        private string lastBridgeRequestId;
        private readonly string startedAt = DateTime.UtcNow.ToString("o");

        public ProbeForm(Options options)
        {
            this.options = options;
            expectedAsin = options.ExpectedAsin ?? "";
            Text = "Amazon 商品页只读探针 · 独立 WebView2 Profile";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1100, 720);
            Size = new Size(1500, 960);
            BuildUi();
            Shown += async delegate { try { await InitializeBrowserAsync(); } catch (Exception ex) { WriteAudit("browser_init_error", ex.GetType().Name + ": " + ex.Message); SetStatus("WebView2 初始化失败 · " + ex.GetType().Name); } };
            FormClosed += delegate { bridgeTimer.Stop(); heartbeatTimer.Stop(); bridgeTimer.Dispose(); heartbeatTimer.Dispose(); browser.Dispose(); };
            WriteAudit("process_start", "pid=" + Process.GetCurrentProcess().Id + "; user=" + WindowsIdentity.GetCurrent().Name + "; session=" + Process.GetCurrentProcess().SessionId + "; interactive=" + Environment.UserInteractive + "; profile=" + options.Profile + "; runtime=" + Environment.OSVersion.VersionString);
            WriteRuntimeManifest();
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
            bar.Controls.Add(MakeButton("刷新", 64, delegate { if (browser.CoreWebView2 != null) browser.CoreWebView2.Reload(); }));
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
            WriteAudit("environment_create_start", "proxy=" + SafeHost(options.Proxy));
            var environment = await CoreWebView2Environment.CreateAsync(null, options.Profile, envOptions);
            WriteAudit("environment_create_done", "runtime=" + environment.BrowserVersionString);
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            WriteAudit("core_ready", "source=" + (core == null ? "null" : "available"));
            webViewInitialized = core != null;
            WriteRuntimeManifest();
            const string networkObserver = "(function(){if(window.__amazonProbeObserver)return;window.__amazonProbeObserver=true;function emit(kind,method,url,status){try{var u=new URL(url,location.href);if(u.hostname==='amazon.de'||u.hostname.endsWith('.amazon.de'))window.chrome.webview.postMessage(JSON.stringify({kind:kind,method:method||'',host:u.hostname,path:u.pathname,status:status==null?null:status,time:new Date().toISOString()}));}catch(e){}}var oldFetch=window.fetch;if(oldFetch)window.fetch=function(){var a=arguments;var url=typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||'';var method=(a[1]&&a[1].method)||(a[0]&&a[0].method)||'GET';emit('fetch_start',method,url,null);return oldFetch.apply(this,a).then(function(r){emit('fetch_response',method,url,r.status);return r;},function(e){emit('fetch_error',method,url,null);throw e;});};var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__amazonProbeMethod=m;this.__amazonProbeUrl=u;return xo.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){var x=this;emit('xhr_start',x.__amazonProbeMethod,x.__amazonProbeUrl,null);x.addEventListener('loadend',function(){emit('xhr_response',x.__amazonProbeMethod,x.__amazonProbeUrl,x.status);});return xs.apply(this,arguments);};})();";
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
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = true;
            core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                if (!Options.IsAmazonUrl(e.Uri)) { e.Cancel = true; SetStatus("已阻止非 amazon.de 页面导航"); WriteAudit("navigation_blocked", "host=" + SafeHost(e.Uri)); return; }
                SetStatus("正在打开 " + SafeHost(e.Uri));
                WriteAudit("navigation_starting", "url=" + SanitizeUrl(e.Uri));
            };
            core.NavigationCompleted += async delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                SetStatus(e.IsSuccess ? "页面导航完成 · " + SafeHost(browser.Source == null ? "" : browser.Source.ToString()) : "页面导航失败 · " + e.WebErrorStatus);
                WriteAudit("navigation_completed", "success=" + e.IsSuccess + "; error=" + e.WebErrorStatus);
                if (navigationCompletion != null)
                {
                    var navResult = new Dictionary<string, object>();
                    navResult["success"] = e.IsSuccess;
                    navResult["web_error"] = e.WebErrorStatus.ToString();
                    navResult["url"] = browser.Source == null ? "" : SanitizeUrl(browser.Source.ToString());
                    navResult["http_status"] = LastStatusForPath(SafePath(browser.Source == null ? "" : browser.Source.ToString()));
                    navigationCompletion.TrySetResult(navResult);
                    navigationCompletion = null;
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
                    if (Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out uri) && IsAmazonHost(uri.ToString()))
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
            heartbeatTimer.Interval = 1000;
            heartbeatTimer.Tick += delegate { TouchBridgeHeartbeat(); };
            bridgeWorkerStarted = true;
            TouchBridgeHeartbeat();
            bridgeTimer.Start();
            heartbeatTimer.Start();
            WriteRuntimeManifest();
            WriteAudit("file_bridge_ready", "root=" + options.BridgeRoot);
            core.Navigate(options.InitialUrl);
        }

        private async Task InspectDomAsync()
        {
            if (browser.CoreWebView2 == null || domBusy) return;
            domBusy = true;
            try
            {
            string script = DomSummaryScript(expectedAsin);
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
                    lastBridgeRequestId = id;
                    var args = request.ContainsKey("args") ? request["args"] as Dictionary<string, object> : null;
                    response["result"] = await HandleBridgeCommandAsync(command, args);
                    response["ok"] = true;
                    WriteAudit("bridge_command", "command=" + command + "; id=" + id + "; ok=true");
                }
                catch (Exception ex)
                {
                    response["error_code"] = ex is InvalidOperationException ? ex.Message : ex.GetType().Name.ToUpperInvariant();
                    lastBridgeWorkerError = Convert.ToString(response["error_code"]);
                    WriteAudit("bridge_command", "id=" + id + "; ok=false; error=" + response["error_code"]);
                }
                string responsePath = Path.Combine(outbox, id + ".json");
                string tempPath = responsePath + ".tmp";
                File.WriteAllText(tempPath, json.Serialize(response), new UTF8Encoding(false));
                if (File.Exists(responsePath)) File.Delete(responsePath);
                File.Move(tempPath, responsePath);
            }
            catch (Exception ex) { lastBridgeWorkerError = ex.GetType().Name.ToUpperInvariant(); WriteAudit("bridge_poll_error", ex.GetType().Name); WriteRuntimeManifest(); }
            finally { bridgeBusy = false; }
        }

        private async Task<object> HandleBridgeCommandAsync(string command, Dictionary<string, object> args)
        {
            switch (command)
            {
                case "status":
                    var state = await ExecuteJsonAsync("(function(){var c=document.querySelector('link[rel=canonical]'),u='';try{u=c?new URL(c.href,location.href).origin+new URL(c.href,location.href).pathname:'';}catch(x){}return JSON.stringify({url:location.origin+location.pathname,canonical_url:u||null,title:document.title||'',readyState:document.readyState});})()");
                    state["pid"] = Process.GetCurrentProcess().Id;
                    state["binary"] = Process.GetCurrentProcess().MainModule.FileName;
                    state["profile"] = options.Profile;
                    state["bridge_root"] = options.BridgeRoot;
                    return state;
                case "navigate":
                    string target = GetString(args, "url");
                    if (!Options.IsAmazonUrl(target)) throw new InvalidOperationException("NAVIGATION_RESTRICTED_TO_HTTPS_AMAZON_DE");
                    string expected = GetString(args, "expected_asin");
                    if (!String.IsNullOrWhiteSpace(expected) && !Regex.IsMatch(expected, "^[A-Z0-9]{10}$", RegexOptions.IgnoreCase)) throw new InvalidOperationException("EXPECTED_ASIN_INVALID");
                    expectedAsin = expected.ToUpperInvariant();
                    var pending = new TaskCompletionSource<Dictionary<string, object>>();
                    navigationCompletion = pending;
                    browser.CoreWebView2.Navigate(target);
                    var completed = await Task.WhenAny(pending.Task, Task.Delay(30000));
                    if (completed != pending.Task) { navigationCompletion = null; return new Dictionary<string, object> { { "success", false }, { "error_code", "NAVIGATION_TIMEOUT" } }; }
                    var nav = pending.Task.Result;
                    nav["title"] = browser.CoreWebView2.DocumentTitle;
                    var navIdentity = await ExecuteJsonAsync(DomSummaryScript(expectedAsin));
                    nav["requested_asin"] = navIdentity.ContainsKey("requested_asin") ? navIdentity["requested_asin"] : null;
                    nav["canonical_url"] = navIdentity.ContainsKey("canonical_url") ? navIdentity["canonical_url"] : null;
                    nav["canonical_asin"] = navIdentity.ContainsKey("canonical_asin") ? navIdentity["canonical_asin"] : null;
                    nav["asin_match"] = navIdentity.ContainsKey("asin_match") ? navIdentity["asin_match"] : "unknown";
                    return nav;
                case "get_dom_snapshot":
                    return await ExecuteJsonAsync(DomSummaryScript(expectedAsin));
                case "get_page_data":
                    return await GetPageDataAsync(args);
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

        private string DomSummaryScript(string requestedAsin)
        {
            return "(function(){var b=document.body,t=(b&&b.innerText)||'',expected=" + json.Serialize(requestedAsin ?? "") + ";var vis=function(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};var ds=Array.prototype.slice.call(document.querySelectorAll('[role=dialog],[aria-modal=true],dialog,[class*=sp-cc],[id*=sp-cc]'));var cm=ds.some(function(e){return vis(e)&&/cookie|cookies|privacy|consent|datenschutz/i.test(e.innerText||e.getAttribute('aria-label')||'' )});var login=/sign in|anmelden|iniciar sesi[oó]n/i.test(t.slice(0,3000));var hs=Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).filter(vis).slice(0,12).map(function(e){return (e.innerText||'').trim().slice(0,180)});var c=document.querySelector('link[rel=canonical]'),cu='';try{cu=c?new URL(c.href,location.href).origin+new URL(c.href,location.href).pathname:'';}catch(x){}var src=cu||location.origin+location.pathname,m=src.match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})(?:\\/|$)/i),aid=m?m[1].toUpperCase():'';return JSON.stringify({url:location.origin+location.pathname,canonical_url:cu||null,title:document.title||'',readyState:document.readyState,bodyTextLength:t.length,requested_asin:expected||null,canonical_asin:aid||null,asin_match:expected?(aid?(expected===aid?'true':'false'):'unknown'):'unknown',headings:hs,cookieModalDetected:cm,loginPromptDetected:login,sensitiveValuesRead:false});})()";
        }

        private async Task<object> GetPageDataAsync(Dictionary<string, object> args)
        {
            if (browser.CoreWebView2 == null) throw new InvalidOperationException("WEBVIEW_NOT_READY");
            string requested = GetString(args, "expected_asin").ToUpperInvariant();
            if (!Regex.IsMatch(requested, "^[A-Z0-9]{10}$") || !String.Equals(requested, expectedAsin, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("EXPECTED_ASIN_GATE_FAILED");
            var result = await ExecuteJsonAsync(PageDataScript(requested));
            lock (networkLock)
            {
                var rows = networkMetadata.Select(item => new Dictionary<string, object>
                {
                    { "host", item.ContainsKey("host") ? item["host"] : null },
                    { "path", item.ContainsKey("path") ? item["path"] : null },
                    { "method", item.ContainsKey("method") ? item["method"] : null },
                    { "status", item.ContainsKey("status") ? item["status"] : null },
                    { "content_type", item.ContainsKey("content_type") ? item["content_type"] : null },
                    { "query_parameter_names", item.ContainsKey("query_parameter_names") ? item["query_parameter_names"] : new List<string>() },
                    { "body_saved", false }, { "cookie_saved", false }, { "authorization_saved", false }
                }).ToList();
                result["network_evidence"] = new Dictionary<string, object>
                {
                    { "status", rows.Count > 0 ? "AVAILABLE_PARTIAL" : "UNKNOWN" },
                    { "value", rows },
                    { "evidence_ref", "webview2:sanitized-network-metadata" }
                };
            }
            return RedactObject(result);
        }

        private string PageDataScript(string requestedAsin)
        {
            string expected = json.Serialize((requestedAsin ?? "").ToUpperInvariant());
            return @"(function(){
var expected=" + expected + @", now=new Date().toISOString();
var txt=function(e,max){if(!e)return null;var v=String(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();return v?v.slice(0,max||1200):null;};
var visible=function(e){if(!e)return false;var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
var cleanUrl=function(v){try{var u=new URL(v,location.href);if(u.protocol!=='https:'||!/(^|\.)amazon\.de$/i.test(u.hostname))return null;return u.origin+u.pathname;}catch(e){return null;}};
var cleanImage=function(v){try{var u=new URL(v,location.href);if(u.protocol!=='https:'||!/(^|\.)amazon\.de$|(^|\.)media-amazon\.com$/i.test(u.hostname))return null;return u.origin+u.pathname;}catch(e){return null;}};
var field=function(v,sel,status){return {status:status||(v===null||v===undefined||v===''?'NOT_PRESENT':'AVAILABLE_REAL'),value:v===undefined?null:v,evidence_ref:sel?('dom:'+sel):null};};
var allText=function(selectors,maxItems,maxLength){var out=[],used={};selectors.forEach(function(sel){Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function(e){if(out.length>=maxItems||!visible(e))return;var v=txt(e,maxLength);if(v&&!used[v]){used[v]=1;out.push(v);}});});return out;};
var canonical=null;var link=document.querySelector('link[rel=canonical]');if(link)canonical=cleanUrl(link.href);if(!canonical)canonical=cleanUrl(location.href);
var asinMatch=canonical&&canonical.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i), canonicalAsin=asinMatch?asinMatch[1].toUpperCase():null;
var titleEl=document.querySelector('#productTitle');var title=visible(titleEl)?txt(titleEl,600):null;
var priceEls=Array.prototype.slice.call(document.querySelectorAll('#corePrice_feature_div .a-offscreen,#apex_offerDisplay_desktop .a-offscreen,.a-price .a-offscreen')).filter(visible);var price=priceEls.length?txt(priceEls[0],100):null;
var main=document.querySelector('#landingImage,#imgBlkFront');var mainUrl=main?cleanImage(main.getAttribute('data-old-hires')||main.getAttribute('src')):null;
var images=[];Array.prototype.slice.call(document.querySelectorAll('#altImages img')).forEach(function(e){if(images.length>=12)return;var u=cleanImage(e.getAttribute('src')||e.getAttribute('data-src'));if(u&&images.indexOf(u)<0)images.push(u);});if(mainUrl&&images.indexOf(mainUrl)<0)images.unshift(mainUrl);
var bullets=allText(['#feature-bullets li:not(.aok-hidden)'],12,600);
var description=allText(['#productDescription','#aplus','#aplus_feature_div'],3,1600).join('\n')||null;
var specs=allText(['#productDetails_techSpec_section_1 tr','#productDetails_detailBullets_sections1 tr','#detailBullets_feature_div li'],40,400);
var qtyExpr=function(rows){var out=[];rows.forEach(function(s){var m=s.match(/\b\d{1,4}\s*(?:x|stück|st\.?|teile|pcs|count|pack|set)\b/ig);if(m)m.forEach(function(x){if(out.indexOf(x)===-1)out.push(x);});});return out;};
var bqty=qtyExpr(bullets), sqty=qtyExpr(specs), allq=bqty.concat(sqty).filter(function(x,i,a){return a.indexOf(x)===i;});
var packageConsistency=(bqty.length&&sqty.length&&bqty.join('|')!==sqty.join('|'))?'SOURCE_CONFLICT_WITHIN_PAGE':'NO_CONFLICT_REPORTED';
var ratingEl=document.querySelector('#acrPopover,[data-hook=rating-out-of-text]');var rating=ratingEl?(ratingEl.getAttribute('title')||ratingEl.getAttribute('aria-label')||txt(ratingEl,120)):null;
var countEl=document.querySelector('#acrCustomerReviewText,[data-hook=total-review-count]');var ratingCount=countEl?txt(countEl,100):null;
var reviews=[];Array.prototype.slice.call(document.querySelectorAll('[data-hook=review]')).slice(0,5).forEach(function(r,i){if(!visible(r))return;var title=txt(r.querySelector('[data-hook=review-title]'),240),body=txt(r.querySelector('[data-hook=review-body]'),1400),date=txt(r.querySelector('[data-hook=review-date]'),120),star=r.querySelector('[data-hook=review-star-rating],[data-hook=cmps-review-star-rating]'),rr=star?(star.getAttribute('title')||star.getAttribute('aria-label')||txt(star,80)):null;if(title||body)reviews.push({title:field(title,'[data-hook=review-title]'),body:field(body,'[data-hook=review-body]'),date:field(date,'[data-hook=review-date]'),rating:field(rr,'[data-hook=review-star-rating]'),evidence_ref:'dom:[data-hook=review]['+i+']'});});
var sellerEl=document.querySelector('#sellerProfileTriggerId,#merchant-info a[href*=seller]');var seller=sellerEl?txt(sellerEl,200):null;var sellerBlock=document.querySelector('#merchant-info');var offer=sellerBlock?txt(sellerBlock,500):null;
var delivery=allText(['#mir-layout-DELIVERY_BLOCK','#deliveryBlockMessage','#deliveryBlock_feature_div'],3,400).join(' | ')||null;
var modal=Array.prototype.slice.call(document.querySelectorAll('[role=dialog],[aria-modal=true],dialog,#sp-cc')).some(visible);
var login=/sign in|anmelden|iniciar sesi[oó]n/i.test((document.body&&document.body.innerText||'').slice(0,2500));
var matches=!!expected&&!!canonicalAsin&&expected===canonicalAsin;
var result={schema:'AMAZON_PAGE_PROBE_PERSISTED_RESULT',schema_version:1,result_status:matches?'PASS':'FAIL',identity:{marketplace:field('Amazon.de','url'),requested_asin:field(expected||null,'request.expected_asin',expected?'AVAILABLE_REAL':'UNKNOWN'),canonical_asin:field(canonicalAsin,'link[rel=canonical] / URL',canonicalAsin?'AVAILABLE_REAL':'UNKNOWN'),asin_match:field(matches,'identity gate',matches?'AVAILABLE_REAL':'BLOCKED'),canonical_url:field(canonical,'link[rel=canonical] / URL',canonical?'AVAILABLE_REAL':'UNKNOWN')},product_content:{title:field(title,'#productTitle'),bullet_points:field(bullets,'#feature-bullets li',bullets.length?'AVAILABLE_REAL':'NOT_PRESENT'),description:field(description,'#productDescription, #aplus',description?'AVAILABLE_REAL':'NOT_PRESENT')},images:{main_image:field(mainUrl,'#landingImage'),image_list:field(images,'#altImages img',images.length?'AVAILABLE_REAL':'NOT_PRESENT')},specifications:{technical_details:field(specs,'#productDetails_techSpec_section_1 tr, #detailBullets_feature_div li',specs.length?'AVAILABLE_REAL':'NOT_PRESENT')},package_contents:field({consistency:packageConsistency,bullet_quantity_expression:bqty,spec_quantity_expressions:sqty,observed_quantity_expressions:allq},'#feature-bullets / product details'),ratings_summary:{rating:field(rating,'#acrPopover'),rating_count:field(ratingCount,'#acrCustomerReviewText'),count_semantics:'rating_count; not confirmed text review_count',review_count:{status:'NOT_CONFIRMED',value:null}},inline_reviews:field({review_scope:reviews.length?'INLINE_SAMPLE':'NO_REVIEWS',items:reviews,observed_dom_review_nodes:document.querySelectorAll('[data-hook=review]').length,saved_item_count:reviews.length,complete_review_set_claimed:false},'[data-hook=review]',reviews.length?'AVAILABLE_PARTIAL':'NOT_PRESENT'),review_pagination:field({status:'UNKNOWN',login_prompt_detected:login,login_performed:false,complete_review_set_claimed:false},'#customer-reviews_feature_div'),seller_offer:{seller:field(seller,'#sellerProfileTriggerId, #merchant-info'),current_buy_box:field(offer,'#merchant-info')},delivery_context:{destination_country:field(null,'page locale UNKNOWN','UNKNOWN'),displayed_currency:field(price&&/[€]/.test(price)?'EUR':price&&/[£]/.test(price)?'GBP':price&&/[$]/.test(price)?'USD':null,'displayed price context',price?'AVAILABLE_PARTIAL':'UNKNOWN'),displayed_price:field(price?{text:price,usable_for_amazon_de_local_price_comparison:false}:null,'.a-price .a-offscreen'),delivery:field(delivery,'#deliveryBlockMessage')},checked_at:field(now,'probe clock'),page_state:{ready_state:document.readyState,title:document.title||'',cookie_modal_detected:modal,login_prompt_detected:login},safety:{amazon_login_performed:false,cookie_values_saved:false,authorization_saved:false,request_response_bodies_saved:false}};
return JSON.stringify(result);
})()";
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
            if (String.IsNullOrWhiteSpace(label) || label.Length > 100 || !Regex.IsMatch(label, "(mehr|anzeigen|weiterlesen|alle rezensionen|rezensionen|bewertung|details|show more|read more|reviews)", RegexOptions.IgnoreCase) || Regex.IsMatch(label, "(kaufen|bestellen|warenkorb|anmelden|login|entfernen|bezahlen|submit|place order|buy now)", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("CLICK_NOT_IN_READONLY_ALLOWLIST");
            string script = "(function(){var q=" + json.Serialize(label) + ",es=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],summary,a')),hit=null;for(var i=0;i<es.length;i++){var e=es[i],s=(e.innerText||e.getAttribute('aria-label')||'').trim(),r=e.getBoundingClientRect(),cs=getComputedStyle(e);if(!s||s.toLowerCase().indexOf(q.toLowerCase())<0||e.disabled||e.getAttribute('aria-expanded')==='true'||e.closest('form')||r.width===0||r.height===0||cs.display==='none'||cs.visibility==='hidden')continue;if(e.tagName==='A'){var u;try{u=new URL(e.href,location.href)}catch(x){continue;}if(u.hostname!=='amazon.de'&&!u.hostname.endsWith('.amazon.de'))continue;if(!/(review|customer-reviews|detail|feature|product)/i.test(u.pathname+u.hash))continue;}hit={el:e,label:s,tag:e.tagName.toLowerCase()};break;}if(!hit)return JSON.stringify({clicked:false,reason:'NO_SAFE_MATCH'});hit.el.click();return JSON.stringify({clicked:true,label:hit.label.slice(0,120),tag:hit.tag});})()";
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

        private void TouchBridgeHeartbeat()
        {
            if (!bridgeWorkerStarted) return;
            bridgeWorkerHeartbeatAt = DateTime.UtcNow.ToString("o");
            WriteRuntimeManifest();
        }

        private void WriteRuntimeManifest()
        {
            lock (manifestLock)
            {
                try
                {
                    string inbox = Path.GetFullPath(Path.Combine(options.BridgeRoot, "inbox"));
                    string outbox = Path.GetFullPath(Path.Combine(options.BridgeRoot, "outbox"));
                    var state = new Dictionary<string, object>();
                    state["probe_pid"] = Process.GetCurrentProcess().Id;
                    state["started_at"] = startedAt;
                    state["binary_path"] = Process.GetCurrentProcess().MainModule.FileName;
                    state["profile_path"] = options.Profile;
                    state["bridge_root"] = options.BridgeRoot;
                    state["inbox_path"] = inbox;
                    state["outbox_path"] = outbox;
                    state["expected_url"] = options.InitialUrl;
                    state["expected_asin"] = options.ExpectedAsin;
                    state["webview_initialized"] = webViewInitialized;
                    state["bridge_worker_started"] = bridgeWorkerStarted;
                    state["bridge_worker_heartbeat_at"] = bridgeWorkerHeartbeatAt;
                    state["desktop_session"] = Process.GetCurrentProcess().SessionId;
                    state["last_bridge_request_id"] = lastBridgeRequestId;
                    state["last_bridge_worker_error"] = lastBridgeWorkerError;
                    string parent = Path.GetDirectoryName(options.RuntimeManifestPath);
                    Directory.CreateDirectory(parent);
                    string temp = options.RuntimeManifestPath + "." + Process.GetCurrentProcess().Id + ".tmp";
                    File.WriteAllText(temp, json.Serialize(state), new UTF8Encoding(false));
                    if (File.Exists(options.RuntimeManifestPath)) File.Replace(temp, options.RuntimeManifestPath, null);
                    else File.Move(temp, options.RuntimeManifestPath);
                }
                catch (Exception ex)
                {
                    lastBridgeWorkerError = "RUNTIME_MANIFEST_" + ex.GetType().Name.ToUpperInvariant();
                    WriteAudit("runtime_manifest_error", lastBridgeWorkerError);
                }
            }
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
            if (!Options.IsAmazonUrl(address.Text.Trim())) { SetStatus("仅允许 HTTPS amazon.de 页面"); return; }
            browser.CoreWebView2.Navigate(address.Text.Trim());
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
        private static bool IsAmazonHost(string value) { return Options.IsAmazonUrl(value); }
        private static string SafeHost(string value) { Uri u; return Uri.TryCreate(value, UriKind.Absolute, out u) ? u.Host : "unknown"; }
        private static string SafePath(string value) { Uri u; return Uri.TryCreate(value, UriKind.Absolute, out u) ? u.AbsolutePath : "/"; }
        private static string SanitizeUrl(string value) { return SafeHost(value) + SafePath(value); }
    }
}
