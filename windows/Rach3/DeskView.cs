using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Rach3
{
    /// <summary>
    /// The window side of the "With AI" tab: files of the candidates ChatGPT showed, served
    /// to the page at /_desk/, and the YouTube player laid over a card (desktop/main.m playVideo).
    /// </summary>
    sealed partial class MainForm
    {
        // Candidates' files come from a host of their own, answered only by rach3: the page's
        // host is a folder mapping, which these requests must not go through.
        const string DeskFiles = "https://desk." + Host + "/";
        // YouTube wants a web origin to embed from, which the app page's own host is not.
        // This one page is answered by rach3 itself and never reaches the network.
        const string VideoPage = "https://rach3.com/rach3-app-video";

        Panel videoClip;
        WebView2 videoView;
        string videoIdentifier;
        bool videoFullscreen;

        async Task InitializeDesk(CoreWebView2 core)
        {
            if (!chat.Available) return;
            // Runs before the page's <html> exists; marks it as soon as it does, before any page script.
            await core.AddScriptToExecuteOnDocumentCreatedAsync("(() => {" +
                "if (window.location.href !== '" + PageUrl + "') return;" +
                "const mark = () => { if (!document.documentElement) return false; document.documentElement.dataset.lessonChat = '1'; return true; };" +
                "if (!mark()) new MutationObserver((changes, observer) => { if (mark()) observer.disconnect(); }).observe(document, { childList: true });" +
                "})();");
            core.AddWebResourceRequestedFilter(DeskFiles + "_desk/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnDeskFile;
        }

#if PIANO_CAPTURE
        readonly List<string> deskRequests = new List<string>();
#endif

        async void OnDeskFile(object sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
#if PIANO_CAPTURE
            lock (deskRequests) deskRequests.Add(args.Request.Uri);
#endif
            if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var url) || !args.Request.Uri.StartsWith(DeskFiles, StringComparison.Ordinal)) return;
            var deferral = args.GetDeferral();
            try
            {
                Tuple<byte[], string> file = null;
                try { file = await chat.ServedFile(Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/'))); }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException) { }
                var environment = web.CoreWebView2?.Environment;
                if (environment == null) return;
                args.Response = file == null
                    ? environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain")
                    : environment.CreateWebResourceResponse(new MemoryStream(file.Item1), 200, "OK",
                        "Content-Type: " + file.Item2 + "\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: https://" + Host);
            }
#if PIANO_CAPTURE
            catch (Exception error) { lock (deskRequests) deskRequests.Add(error.ToString()); throw; }
#endif
            finally { deferral.Complete(); }
        }

        static bool IsVideoId(string identifier) =>
            identifier != null && identifier.Length == 11 &&
            identifier.All(c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-');

        /// <summary>A YouTube video ChatGPT showed plays over its card, in a separate private web view.</summary>
        async Task PlayVideo(string link)
        {
            var identifier = LessonDesk.YouTubeId(link);
            if (!IsVideoId(identifier)) return;
            videoIdentifier = identifier;
            if (videoView == null)
            {
                videoClip = new Panel { Visible = false, BackColor = Color.Black };
                videoView = new WebView2 { DefaultBackgroundColor = Color.Black };
                videoClip.Controls.Add(videoView);
                Controls.Add(videoClip);
                videoClip.BringToFront();
                var view = videoView;
                var environment = web.CoreWebView2.Environment;
                var options = environment.CreateCoreWebView2ControllerOptions();
                options.IsInPrivateModeEnabled = true;
                await view.EnsureCoreWebView2Async(environment, options);
                if (view != videoView) return;
                var core = view.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.AddWebResourceRequestedFilter("https://rach3.com/*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (sender, args) =>
                {
                    var page = args.Request.Uri.StartsWith(VideoPage + "?v=", StringComparison.Ordinal) ? VideoHtml(args.Request.Uri.Substring(VideoPage.Length + 3)) : null;
                    args.Response = page == null
                        ? core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain")
                        : core.Environment.CreateWebResourceResponse(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(page)), 200, "OK",
                            "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
                };
                core.NavigationStarting += (sender, args) =>
                {
                    if (!args.Uri.StartsWith(VideoPage + "?v=", StringComparison.Ordinal)) args.Cancel = true;
                };
                // "Watch on YouTube" and other links leave the app for the browser.
                core.NewWindowRequested += (sender, args) =>
                {
                    args.Handled = true;
                    if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var target) && target.Scheme == Uri.UriSchemeHttps &&
                        (target.Host == "www.youtube.com" || target.Host == "youtube.com" || target.Host == "youtu.be"))
                        OpenInBrowser(target.AbsoluteUri);
                };
                core.ContainsFullScreenElementChanged += (sender, args) =>
                {
                    videoFullscreen = core.ContainsFullScreenElement;
                    if (videoFullscreen) { videoClip.Bounds = ClientRectangle; videoView.Bounds = new Rectangle(Point.Empty, ClientSize); videoClip.Visible = true; }
                    else videoClip.Visible = false;   // until the page places it again
                };
            }
            if (videoView?.CoreWebView2 == null || videoIdentifier != identifier) return;
            videoClip.Visible = false;   // until the page says where the card is
            videoView.CoreWebView2.Navigate(VideoPage + "?v=" + identifier);
        }

        static string VideoHtml(string identifier) => !IsVideoId(identifier) ? null :
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
            "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>" +
            "<iframe src='https://www.youtube-nocookie.com/embed/" + identifier + "?autoplay=1&rel=0&playsinline=1' referrerpolicy='strict-origin-when-cross-origin' " +
            "allow='autoplay; encrypted-media; fullscreen; picture-in-picture' allowfullscreen></iframe>";

        /// <summary>The page reports the card's frame and the part of it that is visible, in its own pixels.</summary>
        void PlaceVideo(Dictionary<string, object> body)
        {
            if (videoClip == null || videoFullscreen) return;
            double[] Box(string key)
            {
                if (!body.TryGetValue(key, out var raw)) return null;
                var list = Collections.AsList(raw);
                if (list.Count != 4) return null;
                var box = new double[4];
                for (var i = 0; i < 4; i++)
                {
                    if (list[i] == null || list[i] is string || list[i] is bool) return null;
                    box[i] = Convert.ToDouble(list[i], System.Globalization.CultureInfo.InvariantCulture);
                }
                return box;
            }
            var frame = Box("frame");
            var clip = Box("clip");
            if (frame == null || clip == null) { videoClip.Visible = false; return; }
            var scale = DeviceDpi / 96.0 * web.ZoomFactor;
            Rectangle ToWindow(double[] box) => new Rectangle(
                web.Left + (int)Math.Round(box[0] * scale), web.Top + (int)Math.Round(box[1] * scale),
                (int)Math.Round(Math.Max(0, box[2]) * scale), (int)Math.Round(Math.Max(0, box[3]) * scale));
            var outer = ToWindow(clip);
            var inner = ToWindow(frame);
            if (outer.Width < 1 || outer.Height < 1) { videoClip.Visible = false; return; }
            videoClip.Bounds = outer;
            videoView.Bounds = new Rectangle(inner.X - outer.X, inner.Y - outer.Y, inner.Width, inner.Height);
            videoClip.Visible = true;
            videoClip.BringToFront();
        }

        void CloseVideo()
        {
            if (videoClip == null) return;
            var clip = videoClip;
            var view = videoView;
            videoClip = null; videoView = null; videoIdentifier = null; videoFullscreen = false;
            Controls.Remove(clip);
            view.Dispose();
            clip.Dispose();
        }

        static void OpenInBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose(); }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException) { }
        }

        async Task<string> DeskCommand(string command, Dictionary<string, object> body)
        {
            switch (command)
            {
                case "desk-state":
                    return Reply(chat.DeskState());
                case "desk-stop":
                    chat.DeskStop(); return Empty;
                case "desk-video-place":
                    PlaceVideo(body); return Empty;
                case "desk-video-close":
                    CloseVideo(); return Empty;
                case "desk-send":
                    var text = body.Text("text") ?? "";
                    if (text.Trim().Length == 0) throw new UserError("empty");
                    var sent = await chat.DeskSend(text);
                    if (sent != null) throw new UserError(sent);
                    return Empty;
                case "desk-make":
                    var made = chat.DeskMake(body.Text("card"));
                    if (made != null) throw new UserError(made);
                    return Empty;
                case "desk-clear":
                    var cleared = chat.DeskClear();
                    if (cleared != null) throw new UserError(cleared);
                    return Empty;
                case "desk-play":
                    var card = chat.DeskCard(body.Text("card"));
                    var link = card?.Text("link");
                    if (link == null) throw new UserError("missing");
                    if (card.TryGetValue("embeddable", out var embeddable) && embeddable is bool playable && !playable)
                    {
                        // Its owner does not let it play inside other apps; it opens on YouTube.
                        if (Uri.TryCreate(link, UriKind.Absolute, out var watch) && watch.Scheme == Uri.UriSchemeHttps && watch.Host == "www.youtube.com")
                            OpenInBrowser(watch.AbsoluteUri);
                        return Reply(new Dictionary<string, object> { ["external"] = true });
                    }
                    await PlayVideo(link);
                    return Empty;
                case "desk-sign-in":
                    var signedIn = await chat.SignIn();
                    if (signedIn != null && signedIn != "cancelled") throw new UserError(signedIn);
                    return Empty;
                default:
                    return null;
            }
        }
    }
}
