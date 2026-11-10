using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Rach3
{
    /// <summary>
    /// The hidden preview (CustomizeService preview: on the Mac): the scratch copy ChatGPT is
    /// changing opens in a window the person never sees, so rach3 and ChatGPT can see it run.
    /// </summary>
    sealed partial class MainForm
    {
        const string PreviewHost = "preview." + Host;
        const string PreviewUrl = "https://" + PreviewHost + "/piano.html";

        sealed class PreviewWindow : Form
        {
            protected override bool ShowWithoutActivation => true;
            protected override CreateParams CreateParams
            {
                get
                {
                    var parameters = base.CreateParams;
                    parameters.ExStyle |= 0x80 | 0x08000000;   // WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE: never in the taskbar or Alt+Tab
                    return parameters;
                }
            }
        }

        PreviewWindow previewWindow;
        WebView2 previewView;
        readonly List<object> previewErrors = new List<object>();
        TaskCompletionSource<bool> previewLoaded;
        Task<Dictionary<string, object>> previewRunning;

        const string PreviewBridge = @"(() => {
  const webview = window.chrome && window.chrome.webview;
  if (!webview || window.top !== window || location.href !== '" + PreviewUrl + @"') return;
  const pending = new Map();
  let next = 1;
  webview.addEventListener('message', ({ data }) => {
    const call = data && pending.get(data.reply);
    if (!call) return;
    pending.delete(data.reply);
    call(data.value);
  });
  const rach3 = Object.freeze({
    postMessage(body) { return new Promise(resolve => { const id = next++; pending.set(id, resolve); webview.postMessage({ id, body }); }); }
  });
  Object.defineProperty(window, 'webkit', { value: Object.freeze({ messageHandlers: Object.freeze({ rach3 }) }) });
  Object.defineProperty(window, 'PianoPlatform', { value: 'windows' });
})();";

        async Task MakePreview(Size size)
        {
            previewWindow = new PreviewWindow
            {
                FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual,
                Location = new Point(-32000, -32000), ClientSize = size, BackColor = BackColor,
            };
            previewView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            previewWindow.Controls.Add(previewView);
            previewWindow.Show();
            // A browser of its own that keeps drawing while nobody can see it, and reaches nothing on the internet.
            var arguments = "--autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion " +
                "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding " + Offline;
            var browser = await CoreWebView2Environment.CreateAsync(null, paths.WebData + "-Preview", new CoreWebView2EnvironmentOptions(arguments));
            var choices = browser.CreateCoreWebView2ControllerOptions();
            choices.IsInPrivateModeEnabled = true;
            await previewView.EnsureCoreWebView2Async(browser, choices);
            var core = previewView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(PreviewBridge);
            var errors = Path.Combine(paths.Resources, "Customize", "page-errors.js");
            var wording = Path.Combine(paths.Resources, "platform-text.json");
            const string preview = "(() => { if (window.top !== window || location.href !== '" + PreviewUrl + "') return; ";
            if (File.Exists(errors)) await core.AddScriptToExecuteOnDocumentCreatedAsync(preview + Files.Read(errors) + "\n})();");
            if (File.Exists(wording)) await core.AddScriptToExecuteOnDocumentCreatedAsync(preview + "window.PianoPlatformText = " + Files.Read(wording) + ";\n})();");
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += async (sender, args) =>
            {
                var deferral = args.GetDeferral();
                try
                {
                    Tuple<byte[], string> file = null;
                    if (Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps && url.Host == PreviewHost && url.IsDefaultPort)
                    {
                        var path = Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/'));
                        if (path == "piano.html" && args.ResourceContext == CoreWebView2WebResourceContext.Document) previewErrors.Clear();
                        file = await customize.Serve("app", path, preview: true);
                    }
                    args.Response = Answer(core.Environment, file);
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException) { }
                finally { deferral.Complete(); }
            };
            core.NavigationStarting += (sender, args) => { if (args.Uri != PreviewUrl) args.Cancel = true; };
            core.NewWindowRequested += (sender, args) => args.Handled = true;
            core.DownloadStarting += (sender, args) => args.Cancel = true;
            core.NavigationCompleted += (sender, args) => previewLoaded?.TrySetResult(true);
            core.WebMessageReceived += async (sender, args) =>
            {
                if (args.Source != PreviewUrl) return;
                Dictionary<string, object> message;
                try { message = Json.Object(args.WebMessageAsJson); } catch (Exception) { return; }
                if (message == null || !(message.TryGetValue("body", out var raw) && raw is Dictionary<string, object> body)) return;
                object value;
                if (body.Text("command") == "page-error")
                {
                    if (previewErrors.Count < 30) previewErrors.Add(body);
                    value = new Dictionary<string, object>();
                }
                else value = await PreviewReply(body);
                previewView?.CoreWebView2?.PostWebMessageAsJson("{\"reply\":" + message.Number("id") + ",\"value\":" + Json.Write(value ?? new Dictionary<string, object>()) + "}");
            };
        }

        /// <summary>Opens the scratch copy, runs script there, and answers {errors, scriptResult, image, snapshotError} or {timedOut, errors}.</summary>
        Task<Dictionary<string, object>> RunPreview(string script)
        {
            // One at a time; core.js never asks for two at once, but a second waits its turn.
            var previous = previewRunning ?? Task.FromResult<Dictionary<string, object>>(null);
            var next = previous.ContinueWith(_ => PreviewOnce(script), TaskScheduler.FromCurrentSynchronizationContext()).Unwrap();
            previewRunning = next;
            return next;
        }

        async Task<Dictionary<string, object>> PreviewOnce(string script)
        {
            var size = web.ClientSize.Width > 0 ? web.ClientSize : new Size(1340, 900);
            var work = PreviewWork(script, size);
            var finished = await Task.WhenAny(work, Task.Delay(25000));
            if (finished != work) return new Dictionary<string, object> { ["timedOut"] = true, ["errors"] = previewErrors.ToList() };
            return await work;
        }

        async Task<Dictionary<string, object>> PreviewWork(string script, Size size)
        {
            if (previewView == null) await MakePreview(size);
            previewWindow.ClientSize = size;
            previewErrors.Clear();
            var core = previewView.CoreWebView2;
            previewLoaded = new TaskCompletionSource<bool>();
            core.Navigate(PreviewUrl);
            await previewLoaded.Task;
            await Task.Delay(2500);
            var result = new Dictionary<string, object>();
            if (script != null)
            {
                // The script may wait for things, so it leaves its answer in a global for rach3 to collect.
                await core.ExecuteScriptAsync("window.__rach3Preview = null; (async () => { try { const value = await (async () => {" + script + "\n})();" +
                    " window.__rach3Preview = { value: value === undefined ? 'undefined' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value) };" +
                    " } catch (error) { window.__rach3Preview = { error: String(error && error.message || error) }; } })();");
                Dictionary<string, object> answer = null;
                while (answer == null)
                {
                    await Task.Delay(200);
                    try { answer = Json.Object(Json.Parse(await core.ExecuteScriptAsync("JSON.stringify(window.__rach3Preview)")) as string ?? "null"); }
                    catch (Exception) { }
                }
                result["scriptResult"] = answer.Text("error") is string failure ? "Error: " + failure : answer.Text("value") ?? "undefined";
            }
            await Task.Delay(800);
            result["errors"] = previewErrors.ToList();
            try
            {
                using (var png = new MemoryStream())
                {
                    await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, png);
                    png.Position = 0;
                    using (var image = Image.FromStream(png))
                    using (var jpeg = new MemoryStream())
                    using (var quality = new EncoderParameters(1))
                    {
                        quality.Param[0] = new EncoderParameter(Encoder.Quality, 72L);
                        image.Save(jpeg, ImageCodecInfo.GetImageEncoders().First(codec => codec.FormatID == ImageFormat.Jpeg.Guid), quality);
                        result["image"] = "data:image/jpeg;base64," + Convert.ToBase64String(jpeg.ToArray());
                    }
                }
            }
            catch (Exception error) when (error is ArgumentException || error is InvalidOperationException || error is ExternalException)
            {
                result["snapshotError"] = error.Message;
            }
            return result;
        }
    }
}
