using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BolAuto.WebView2Shell
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new PaneForm());
        }
    }

    internal sealed class PaneForm : Form
    {
        private const string BolUrl = "http://127.0.0.1:4180/";
        private const string BolooUrl = "https://app.boloo.co/";
        private static readonly string DataRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "BOL数据"));
        private readonly WebView2 bolWeb = new WebView2();
        private readonly WebView2 bolooWeb = new WebView2();
        private readonly Label bolStatus = new Label();
        private readonly Label bolooStatus = new Label();
        private bool started;

        public PaneForm()
        {
            Text = "BOL_AUTO · Boloo 工作台测试 Pane";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1180, 720);
            Size = new Size(1680, 1000);
            BackColor = Color.FromArgb(242, 245, 249);

            var split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Vertical,
                SplitterWidth = 7,
                SplitterDistance = 820,
                FixedPanel = FixedPanel.Panel1,
                BackColor = Color.FromArgb(216, 224, 234)
            };
            split.Panel1.Controls.Add(BuildPane("BOL_AUTO", "产品任务工作台", bolStatus, bolWeb));
            split.Panel2.Controls.Add(BuildPane("BOLOO", "Keyword Explorer · Keyword Extractor 测试", bolooStatus, bolooWeb));
            Controls.Add(split);
            Shown += async delegate { await InitializePanesAsync(); };
            FormClosed += delegate { bolWeb.Dispose(); bolooWeb.Dispose(); };
        }

        private static Control BuildPane(string eyebrow, string title, Label status, WebView2 browser)
        {
            var host = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(1) };
            var header = new Panel { Dock = DockStyle.Top, Height = 62, BackColor = Color.White, Padding = new Padding(18, 9, 14, 7) };
            var eyebrowLabel = new Label
            {
                Text = eyebrow,
                Dock = DockStyle.Top,
                Height = 16,
                ForeColor = Color.FromArgb(81, 105, 135),
                Font = new Font("Segoe UI", 8.25F, FontStyle.Bold)
            };
            var titleLabel = new Label
            {
                Text = title,
                Dock = DockStyle.Fill,
                ForeColor = Color.FromArgb(24, 39, 58),
                Font = new Font("Segoe UI", 11F, FontStyle.Bold)
            };
            header.Controls.Add(titleLabel);
            header.Controls.Add(eyebrowLabel);

            var statusBar = new Panel { Dock = DockStyle.Bottom, Height = 30, BackColor = Color.FromArgb(248, 250, 252), Padding = new Padding(12, 6, 8, 4) };
            status.Text = "正在启动独立 WebView2 Profile…";
            status.Dock = DockStyle.Fill;
            status.ForeColor = Color.FromArgb(84, 101, 122);
            status.Font = new Font("Segoe UI", 8.5F, FontStyle.Regular);
            statusBar.Controls.Add(status);

            browser.Dock = DockStyle.Fill;
            host.Controls.Add(browser);
            host.Controls.Add(statusBar);
            host.Controls.Add(header);
            return host;
        }

        private async Task InitializePanesAsync()
        {
            if (started) return;
            started = true;
            try
            {
                var bolProfile = Path.Combine(DataRoot, "webview2", "bol-shell");
                var bolooProfile = Path.Combine(DataRoot, "webview2", "boloo-pane");
                Directory.CreateDirectory(bolProfile);
                Directory.CreateDirectory(bolooProfile);

                var bolEnvironment = await CoreWebView2Environment.CreateAsync(null, bolProfile);
                var bolooEnvironment = await CoreWebView2Environment.CreateAsync(null, bolooProfile);
                await bolWeb.EnsureCoreWebView2Async(bolEnvironment);
                await bolooWeb.EnsureCoreWebView2Async(bolooEnvironment);

                ConfigureBolPane();
                ConfigureBolooPane();
                bolWeb.CoreWebView2.Navigate(BolUrl);
                bolooWeb.CoreWebView2.Navigate(BolooUrl);
            }
            catch (Exception ex)
            {
                bolStatus.Text = "Pane 启动失败：" + ex.Message;
                bolooStatus.Text = "Pane 启动失败；请保留错误文本供诊断。";
                MessageBox.Show("BOL/Boloo WebView2 测试 Pane 启动失败。\r\n\r\n" + ex.Message, "BOL_AUTO WebView2", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ConfigureBolPane()
        {
            var core = bolWeb.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                Uri uri;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttp || !uri.IsLoopback || uri.Port != 4180)
                    e.Cancel = true;
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                bolStatus.Text = e.IsSuccess ? "BOL_AUTO · 127.0.0.1:4180" : "BOL 页面加载失败；确认本地 BOL 服务已启动。";
            };
        }

        private void ConfigureBolooPane()
        {
            var core = bolooWeb.CoreWebView2;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                Uri uri;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps)
                    e.Cancel = true;
            };
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                bolooStatus.Text = e.IsSuccess
                    ? "Boloo · 独立 Profile · 请 Leon 手工登录；测试数据不会写入正式关键词池。"
                    : "Boloo 导航未成功；无需重试生产 API。请记录错误并检查浏览器网络。";
            };
        }
    }
}
