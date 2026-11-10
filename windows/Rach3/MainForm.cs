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
    /// The Windows counterpart of desktop/main.m: one window around the same offline page, and
    /// the Customize panel beside it. The page talks to window.webkit.messageHandlers.rach3
    /// exactly as on the Mac; Bridge.cs implements that object on top of WebView2's message channel.
    /// </summary>
    sealed partial class MainForm : Form
    {
        /// <summary>
        /// The page's domain. The original rach3 is served at its root; each branch the person
        /// made with ChatGPT at a host of its own below it, so its stored settings stay its own.
        /// </summary>
        public const string Host = "rach3.example";

        readonly Options options;
        readonly Paths paths;
        readonly Settings settings;
        readonly WebView2 web = new WebView2();
        readonly LessonService lessons;
        readonly CustomizeService customize;
        readonly Updates updates;
        readonly Bluetooth bluetooth;
        readonly List<string> pageErrors = new List<string>();
        CoreWebView2Environment environment;
        bool pageReady, quitting, closeAllowed, fullscreen, reloadPending;
        /// <summary>What the page view shows or is loading; null until core.js says which design.</summary>
        string pageUrl;
        Dictionary<string, object> pendingLesson;
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
            lessons.OnIdle = FinishTermination;
            customize = new CustomizeService(paths, Application.ProductVersion);
            lessons.OnEvent = progress =>
            {
                Publish(progress);
                customize.Tell("lesson-progress", new Dictionary<string, object> { ["snapshot"] = progress });
            };
            // The "With AI" tab of Create a Lesson: lessons come from rach3's own import.
            customize.OnDeskEvent = Publish;
            customize.MissingTools = kind => lessons.MissingToolBytes(kind);
            customize.ImportLesson = ImportLesson;
            customize.OnSignedIn = () =>
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Activate();
            };
            // Opens a lesson ChatGPT made, once the version saved with it is on screen.
            customize.OnLessonChanged = lesson =>
            {
                pendingLesson = new Dictionary<string, object>
                {
                    ["event"] = "lesson-progress", ["phase"] = "complete", ["progress"] = 1, ["message"] = "",
                    ["id"] = lesson.TryGetValue("id", out var id) ? id : null, ["title"] = lesson.Text("title") ?? "",
                    ["noteCount"] = lesson.TryGetValue("noteCount", out var notes) ? notes : 0,
                };
                if (pageReady && !reloadPending) OpenPendingLesson();
            };
            customize.OnShow = ShowDesign;
            customize.OnPanel = (open, toggle) =>
            {
                panelOpen = open;
                toggleWidth = Math.Max(60, Math.Min(240, toggle));
                LayoutCustomize();
                (open ? (Control)panel : web)?.Focus();
            };
            customize.Preview = RunPreview;
            updates = new Updates(paths, settings, !capture);
            updates.OnChange = Publish;
            bluetooth = new Bluetooth(settings);
            bluetooth.OnEvent = Publish;
            bluetooth.OnStopped = FinishTermination;
            Load += async (sender, args) => await Initialize();
            Resize += (sender, args) => LayoutCustomize();
        }

        Dictionary<string, object> ImportLesson(Dictionary<string, object> request)
        {
            try
            {
                var kind = request.Text("kind");
                string job = null;
                if (kind == "youtube" && request.Text("link") is string link) job = lessons.ImportYouTube(link, request.Text("title"));
                else if (request.Text("file") is string file) job = lessons.ImportFile(file, kind, request.Text("title"));
                if (job == null) return new Dictionary<string, object> { ["error"] = Localization.Text("Ders başlatılamadı.") };
                BeginInvoke(new Action(() => Publish(lessons.Snapshot())));
                return new Dictionary<string, object> { ["job"] = job };
            }
            catch (Exception error) when (!(error is OutOfMemoryException))
            {
                return new Dictionary<string, object> { ["error"] = Localization.Text(error.Message) ?? Localization.Text("Ders başlatılamadı.") };
            }
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

        // A proxy that is never there: the page and the panel reach nothing on the internet,
        // like on the Mac, whatever a version changed with ChatGPT asks for. rach3's own files
        // are answered before any request could leave.
        const string Offline = "--proxy-server=127.0.0.1:9 --proxy-bypass-list=<-loopback>";

        async Task Initialize()
        {
            try
            {
                var arguments = "--autoplay-policy=no-user-gesture-required " + Offline;
                environment = await CoreWebView2Environment.CreateAsync(null, paths.WebData, new CoreWebView2EnvironmentOptions(arguments));
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
            foreach (var script in PageScripts()) await core.AddScriptToExecuteOnDocumentCreatedAsync(script);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnPageRequest;
            core.WebMessageReceived += OnMessage;
            core.NavigationStarting += (sender, args) =>
            {
                // Only the page of the design on screen; downloads arrive through DownloadStarting.
                if (args.Uri != pageUrl) args.Cancel = true;
            };
            core.NavigationCompleted += (sender, args) => ForgetSeed();
            core.NewWindowRequested += (sender, args) => args.Handled = true;
            core.DownloadStarting += OnDownload;
            core.ProcessFailed += (sender, args) =>
            {
                pageReady = false;
                if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) return;
                bluetooth.Stop();
                core.Reload();
            };
            web.PreviewKeyDown += OnKey;
            web.GotFocus += (sender, args) => pageFocused = true;
            web.LostFocus += (sender, args) => pageFocused = false;
            WatchInput();
            AddWindowMenu();
            await MakePanel();
            LayoutCustomize();
            // The page loads once core.js says which design is on screen; without the panel,
            // or if it never answers, the original rach3 loads.
            if (panel == null) LoadPage(customize.PageUrl, null);
            else
            {
                var timer = new Timer { Interval = 6000 };
                timer.Tick += (sender, args) => { timer.Dispose(); if (pageUrl == null) LoadPage(customize.PageUrl, null); };
                timer.Start();
            }
            if (options.OpenFile != null) OpenVideo(options.OpenFile);
        }

        void OnKey(object sender, PreviewKeyDownEventArgs args)
        {
            if (args.KeyCode == Keys.F11) ToggleFullscreen();
            else if (args.KeyCode == Keys.K && args.Control && !args.Alt && !args.Shift) ToggleCustomize();
        }

        /// <summary>The scripts every page of rach3 starts with, before its own: the bridge, error reports and Windows's wording.</summary>
        IEnumerable<string> PageScripts()
        {
            yield return BridgeScript;
            var errors = Path.Combine(paths.Resources, "Customize", "page-errors.js");
            if (File.Exists(errors)) yield return OnlyOnPage(Files.Read(errors));
            var wording = Path.Combine(paths.Resources, "platform-text.json");
            if (File.Exists(wording)) yield return OnlyOnPage("window.PianoPlatformText = " + Files.Read(wording) + ";");
            // Only a copy that carries Codex offers the "With AI" tab.
            if (customize.Available)
                yield return OnlyOnPage("const mark = () => { if (!document.documentElement) return false; document.documentElement.dataset.lessonChat = '1'; return true; };" +
                    "if (!mark()) new MutationObserver((changes, observer) => { if (mark()) observer.disconnect(); }).observe(document, { childList: true });");
        }

        /// <summary>Wraps a script so it runs only on rach3's page, never in a frame or on another address.</summary>
        static string OnlyOnPage(string script) =>
            "(() => { if (window.top !== window || !" + IsPage + ") return; " + script + "\n})();";

        /// <summary>JavaScript: whether this document is rach3's page on one of its hosts.</summary>
        const string IsPage = "(location.protocol === 'https:' && location.pathname === '/piano.html' && " +
            "(location.hostname === '" + Host + "' || /^[a-z0-9-]{1,63}\\." + "rach3\\.example$/.test(location.hostname)) && location.hostname !== 'panel." + Host + "')";

        /// <summary>The design's label of a page address (app or a branch), or null when it is not rach3's page.</summary>
        static string HostLabel(Uri url)
        {
            if (url == null || url.Scheme != Uri.UriSchemeHttps || !url.IsDefaultPort) return null;
            if (url.Host == Host) return "app";
            var suffix = "." + Host;
            if (!url.Host.EndsWith(suffix, StringComparison.Ordinal)) return null;
            var label = url.Host.Substring(0, url.Host.Length - suffix.Length);
            return label.Length == 0 || label.Contains(".") || label == "app" || label == "panel" || label == "preview" ? null : label;
        }

        /// <summary>Answers every request of the page from rach3's own files; nothing reaches the internet.</summary>
        async void OnPageRequest(object sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            var deferral = args.GetDeferral();
            try
            {
                Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var url);
                var label = HostLabel(url);
                Tuple<byte[], string> file = null;
                if (label != null)
                {
                    var path = Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/'));
                    if (path == "piano.html" && args.ResourceContext == CoreWebView2WebResourceContext.Document)
                        customize.Tell("page-loading");
                    file = await customize.Serve(label, path, preview: false);
                }
                // Anything else is left to fail on the way out (see Offline), as on the Mac.
                if (label != null) args.Response = Answer(web.CoreWebView2?.Environment, file);
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException) { }
            finally { deferral.Complete(); }
        }

        static CoreWebView2WebResourceResponse Answer(CoreWebView2Environment environment, Tuple<byte[], string> file) =>
            environment == null ? null : file == null
                ? environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 404, "Not Found", "Content-Type: text/plain\r\nCache-Control: no-store")
                : environment.CreateWebResourceResponse(new MemoryStream(file.Item1), 200, "OK", "Content-Type: " + file.Item2 + "\r\nCache-Control: no-store");

        // core.js put a design on screen. When the panel has just (re)loaded, a page that
        // already shows that design stays as it is.
        void ShowDesign(bool start)
        {
            var next = customize.PageUrl;
            if (pageUrl == null) { LoadPage(next, null); return; }
            if (start && next == pageUrl) return;
            ReloadDesign();
        }

        void OpenPendingLesson()
        {
            var lesson = pendingLesson;
            pendingLesson = null;
            if (lesson != null) Publish(lesson);
        }

        async Task<string> PageScript(string code)
        {
            try { return web.CoreWebView2 == null ? null : await web.CoreWebView2.ExecuteScriptAsync(code); }
            catch (Exception error) when (error is InvalidOperationException || error is ArgumentException) { return null; }
        }

        // Shows the design that just became active. Waits while a lesson video is being handed over.
        async void ReloadDesign()
        {
            CloseVideo();
            if (reloadPending) return;
            reloadPending = true;
            while (await PageScript("document.documentElement.dataset.lessonPhase === 'upload'") == "true") await Task.Delay(1000);
            await PageScript("window.dispatchEvent(new Event('rach3-save-state'));");
            var next = customize.PageUrl;
            var label = HostLabel(new Uri(next));
            if (HostLabel(new Uri(pageUrl)) == label || !customize.NeedsSeed(label)) { LoadPage(next, null); return; }
            // First visit to this branch: it starts with this page's settings.
            var stored = Json.Parse(await PageScript("JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))") ?? "null") as string;
            LoadPage(next, stored ?? "{}");
        }

        string seedScript;

        async void LoadPage(string url, string seed)
        {
            CloseVideo();
            reloadPending = false; pageReady = false;
            pageUrl = url;
            var core = web.CoreWebView2;
            if (core == null) return;
            ForgetSeed();
            if (seed != null)
            {
                Dictionary<string, object> values = null;
                try { values = Json.Object(seed); } catch (Exception) { }
                var host = new Uri(url).Host;
                var source = "(() => { if (location.host !== " + Json.Write(host) + ") return; try {" +
                    " if (localStorage.getItem('rach3.seeded')) return;" +
                    " for (const [key, value] of Object.entries(" + Json.Write(values ?? new Dictionary<string, object>()) + ")) if (typeof value === 'string') localStorage.setItem(key, value);" +
                    " localStorage.setItem('rach3.seeded', '1'); } catch {} })();";
                seedScript = await core.AddScriptToExecuteOnDocumentCreatedAsync(source);
                if (pageUrl != url) { ForgetSeed(); return; }
            }
            core.Navigate(url);
        }

        void ForgetSeed()
        {
            if (seedScript == null || web.CoreWebView2 == null) return;
            web.CoreWebView2.RemoveScriptToExecuteOnDocumentCreated(seedScript);
            seedScript = null;
        }

        void RestoreOriginalDesign() => customize.Tell("restore-original");

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
            customize.Stop();
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
