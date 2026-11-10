using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Rach3
{
    sealed class Options
    {
        public string Capture, SelfTestMidi, SelfTestPdf, OpenFile;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--capture" && i + 1 < args.Length) options.Capture = args[++i];
                else if (args[i] == "--self-test-midi" && i + 1 < args.Length) options.SelfTestMidi = args[++i];
                else if (args[i] == "--self-test-pdf" && i + 1 < args.Length) options.SelfTestPdf = args[++i];
                else if (!args[i].StartsWith("--", StringComparison.Ordinal)) options.OpenFile = args[i];
            }
            return options;
        }
    }

    /// <summary>
    /// The Windows counterpart of desktop/main.m: one window around the same offline page.
    /// The page talks to window.webkit.messageHandlers.rach3 exactly as on the Mac;
    /// Bridge.js implements that object on top of WebView2's message channel.
    /// </summary>
    sealed partial class MainForm : Form
    {
        public const string Host = "rach3.example";
        public const string PageUrl = "https://" + Host + "/index.html";

        readonly Options options;
        readonly Paths paths;
        readonly Settings settings;
        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        readonly LessonService lessons;
        readonly ChatGptService chat;
        readonly Updates updates;
        readonly Bluetooth bluetooth;
        readonly List<string> pageErrors = new List<string>();
        bool pageReady, quitting, closeAllowed, fullscreen;
        FormWindowState windowedState;
        Rectangle windowedBounds;

        public MainForm(Options options)
        {
            this.options = options;
            var capture = options.Capture != null;
            paths = Paths.Create(capture ? Path.Combine(Path.GetTempPath(), "Rach3Capture") : null);
            if (capture) Files.Delete(paths.Support);
            Directory.CreateDirectory(paths.Support);
            settings = new Settings(paths.Settings);
            Localization.Load(paths.Resources, settings);
            if (capture) Localization.Language = "en";

            Text = "rach3";
            BackColor = Color.FromArgb(19, 20, 23);
            web.DefaultBackgroundColor = BackColor;
            var scale = DeviceDpi / 96f;
            MinimumSize = new Size((int)(820 * scale), (int)(620 * scale));
            StartPosition = FormStartPosition.CenterScreen;
            var screen = Screen.PrimaryScreen.WorkingArea;
            Size = capture ? new Size(1600, 1000) : new Size(Math.Min((int)(1340 * scale), screen.Width), Math.Min((int)(920 * scale), screen.Height));
            LoadPlacement();
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            Controls.Add(web);

            lessons = new LessonService(paths);
            lessons.OnEvent = progress => { Publish(progress); chat.LessonProgress(progress); };
            lessons.OnIdle = FinishTermination;
            chat = new ChatGptService(paths, lessons, Application.ProductVersion);
            chat.OnDeskEvent = Publish;
            chat.OnSignedIn = () =>
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Activate();
            };
            updates = new Updates(paths, settings, !capture);
            updates.OnChange = Publish;
            bluetooth = new Bluetooth(settings);
            bluetooth.OnEvent = Publish;
            bluetooth.OnStopped = FinishTermination;
            Load += async (sender, args) => await Initialize();
        }

        void LoadPlacement()
        {
            if (options.Capture != null || !(settings.Value("Window") is Dictionary<string, object> saved)) return;
            var bounds = new Rectangle((int)saved.Number("x"), (int)saved.Number("y"), (int)saved.Number("width"), (int)saved.Number("height"));
            foreach (var screen in Screen.AllScreens)
            {
                if (!screen.WorkingArea.IntersectsWith(bounds) || bounds.Width < MinimumSize.Width) continue;
                StartPosition = FormStartPosition.Manual; Bounds = bounds;
                if (saved.Flag("maximized", false)) WindowState = FormWindowState.Maximized;
                return;
            }
        }

        void SaveBounds()
        {
            if (options.Capture != null) return;
            var bounds = fullscreen ? windowedBounds : WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            settings.Set("Window", new Dictionary<string, object>
            {
                ["x"] = bounds.X, ["y"] = bounds.Y, ["width"] = bounds.Width, ["height"] = bounds.Height,
                ["maximized"] = (fullscreen ? windowedState : WindowState) == FormWindowState.Maximized,
            });
        }

        async Task Initialize()
        {
            try
            {
                var arguments = "--autoplay-policy=no-user-gesture-required";
                var environment = await CoreWebView2Environment.CreateAsync(null, paths.WebData, new CoreWebView2EnvironmentOptions(arguments));
                await web.EnsureCoreWebView2Async(environment);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this, Localization.Language == "tr"
                    ? "rach3 için Microsoft Edge WebView2 gerekiyor. Windows Update ile veya https://go.microsoft.com/fwlink/p/?LinkId=2124703 adresinden yükleyebilirsin."
                    : "rach3 needs Microsoft Edge WebView2. Install it with Windows Update or from https://go.microsoft.com/fwlink/p/?LinkId=2124703.",
                    "rach3", MessageBoxButtons.OK, MessageBoxIcon.Error);
                closeAllowed = true; Close(); return;
            }
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.SetVirtualHostNameToFolderMapping(Host, paths.Resources, CoreWebView2HostResourceAccessKind.Deny);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
            await InitializeDesk(core);
            core.WebMessageReceived += OnMessage;
            core.NavigationStarting += (sender, args) =>
            {
                // Only the app page itself; downloads arrive through DownloadStarting.
                if (args.Uri != PageUrl) args.Cancel = true;
            };
            core.NewWindowRequested += (sender, args) => args.Handled = true;
            core.DownloadStarting += OnDownload;
            core.ProcessFailed += (sender, args) =>
            {
                pageReady = false;
                if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) return;
                core.Reload();
            };
            web.PreviewKeyDown += (sender, args) => { if (args.KeyCode == Keys.F11) ToggleFullscreen(); };
            core.Navigate(PageUrl);
            if (options.OpenFile != null) OpenVideo(options.OpenFile);
        }

        void OpenVideo(string path)
        {
            try { lessons.OpenVideo(path); }
            catch (Exception error) { ShowError(error.Message); }
        }

        void ShowError(string message) =>
            MessageBox.Show(this, Localization.Text(message) ?? Localization.Text("İşlem tamamlanamadı."), "rach3",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);

        void OnDownload(object sender, CoreWebView2DownloadStartingEventArgs args)
        {
            var deferral = args.GetDeferral();
            BeginInvoke(new Action(() =>
            {
                try
                {
                    using (var dialog = new SaveFileDialog { FileName = Path.GetFileName(args.ResultFilePath), Title = Localization.Text("Kaydet") })
                    {
                        var extension = Path.GetExtension(args.ResultFilePath);
                        if (!string.IsNullOrEmpty(extension)) dialog.Filter = extension.TrimStart('.').ToUpperInvariant() + "|*" + extension;
                        if (dialog.ShowDialog(this) == DialogResult.OK) args.ResultFilePath = dialog.FileName;
                        else args.Cancel = true;
                        args.Handled = true;
                    }
                }
                finally { deferral.Complete(); }
            }));
        }

        Dictionary<string, object> Snapshot() => new Dictionary<string, object>
        {
            ["event"] = "snapshot", ["language"] = Localization.Language, ["status"] = bluetooth.Status(),
            ["held"] = bluetooth.Held(), ["fullscreen"] = fullscreen,
        };

        void Publish(Dictionary<string, object> message)
        {
            if (!pageReady || quitting || web.CoreWebView2 == null) return;
            var localized = Localization.Status(message);
            if (message.TryGetValue("status", out var status) && status is Dictionary<string, object> nested)
                localized["status"] = Localization.Status(nested);
            web.CoreWebView2.PostWebMessageAsJson("{\"event\":" + Json.Write(localized) + "}");
        }

        void ToggleFullscreen()
        {
            if (!fullscreen)
            {
                windowedState = WindowState;
                windowedBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                FormBorderStyle = FormBorderStyle.None;
                if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = windowedState;
                if (windowedState == FormWindowState.Normal) Bounds = windowedBounds;
            }
            fullscreen = !fullscreen;
            Publish(new Dictionary<string, object> { ["event"] = "fullscreen", ["active"] = fullscreen });
        }

        protected override async void OnFormClosing(FormClosingEventArgs args)
        {
            if (closeAllowed) { base.OnFormClosing(args); return; }
            args.Cancel = true;
            if (quitting) return;
            quitting = true;
            SaveBounds();
            try
            {
                if (web.CoreWebView2 != null)
                    await web.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new Event('rach3-save-state'));");
            }
            catch (Exception) { }
            savedWorkspace = true;
            chat.Stop();
            bluetooth.Stop();
            lessons.Cancel();
            FinishTermination();
        }

        bool savedWorkspace;

        void FinishTermination()
        {
            if (!quitting || !savedWorkspace || bluetooth.Active || lessons.Running) return;
            updates.InstallOnExit();
            closeAllowed = true;
            BeginInvoke(new Action(Close));
        }
    }
}
