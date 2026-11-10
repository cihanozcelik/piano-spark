using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace Rach3
{
    sealed partial class MainForm
    {
        /// <summary>
        /// window.webkit.messageHandlers.rach3 on WebView2: postMessage returns a promise
        /// that resolves with the reply or rejects with an Error, like WKScriptMessageHandlerWithReply.
        /// </summary>
        const string BridgeScript = @"(() => {
  const webview = window.chrome && window.chrome.webview;
  if (!webview || window.top !== window || !" + IsPage + @") return;
  const pending = new Map();
  let next = 1;
  webview.addEventListener('message', ({ data }) => {
    if (data && data.reply !== undefined) {
      const call = pending.get(data.reply);
      if (!call) return;
      pending.delete(data.reply);
      if (data.error != null) call.reject(new Error(data.error)); else call.resolve(data.value);
    } else if (data && data.event) {
      window.dispatchEvent(new CustomEvent('rach3-native-event', { detail: data.event }));
    }
  });
  const rach3 = Object.freeze({
    postMessage(body) {
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        webview.postMessage({ id, body });
      });
    }
  });
  Object.defineProperty(window, 'webkit', { value: Object.freeze({ messageHandlers: Object.freeze({ rach3 }) }) });
  Object.defineProperty(window, 'PianoPlatform', { value: 'windows' });
})();";

        async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Only the page of the design on screen may talk to rach3.
            if (pageUrl == null || args.Source != pageUrl) return;
            Dictionary<string, object> message;
            try { message = Json.Object(args.WebMessageAsJson); } catch (Exception) { return; }
            if (message == null || !(message.TryGetValue("body", out var raw) && raw is Dictionary<string, object> body)) return;
            var id = message.Number("id");
            string value = null, error = null;
            try { value = await Dispatch(body); }
            catch (Exception failure) { error = failure is UserError ? failure.Message : Localization.Text(failure.Message); }
            if (web.CoreWebView2 == null) return;
            web.CoreWebView2.PostWebMessageAsJson("{\"reply\":" + id + ",\"value\":" + (value ?? "null") + ",\"error\":" + Json.Write(error) + "}");
        }

        static string Reply(object value) => Json.Write(value);
        static readonly string Empty = "{}";

        /// <summary>Asks core.js for the page; its error codes reach the page as they are.</summary>
        async Task<object> AskCore(string command, Dictionary<string, object> body = null)
        {
            try { return await customize.Ask(command, body); }
            catch (NativeError refusal) { throw new UserError(refusal.Message); }
        }

        /// <summary>core.js hands a lesson over as its saved JSON text.</summary>
        static string LessonText(object result)
        {
            var text = (result as Dictionary<string, object>)?.Text("json");
            try { return text != null && Json.Object(text) != null ? text : null; }
            catch (Exception) { return null; }
        }

        // Code ChatGPT changed runs on this page, so commands that spend the person's
        // ChatGPT plan or start work need a real click or key press on the page first.
        static readonly HashSet<string> NeedsInput = new HashSet<string> { "desk-send", "desk-make", "desk-clear", "desk-play", "desk-sign-in" };

        async Task<string> Dispatch(Dictionary<string, object> body)
        {
            var command = body.Text("command");
            if (command != null && NeedsInput.Contains(command))
            {
                if ((DateTime.UtcNow - pageInput).TotalSeconds > 2) throw new UserError("Bunu bir tıklamayla ya da Enter’la yap.");
                pageInput = DateTime.MinValue;
            }
            switch (command)
            {
                case "get-language":
                    return Reply(new Dictionary<string, object> { ["language"] = Localization.Language });
                case "set-language":
                    var language = body.Text("language");
                    if (language != "en" && language != "tr") throw new UserError("Desteklenmeyen dil.");
                    Localization.Language = language;
                    AddWindowMenu();
                    BeginInvoke(new Action(() =>
                    {
                        Publish(new Dictionary<string, object> { ["event"] = "language", ["language"] = language });
                        Publish(Snapshot()); Publish(updates.Snapshot()); Publish(lessons.Snapshot());
                        customize.Tell("language", new Dictionary<string, object> { ["language"] = language });
                    }));
                    return Reply(new Dictionary<string, object> { ["language"] = language });
                case "subscribe":
                    pageReady = true;
                    Trace.WriteLine("rach3 page ready");
                    MakeRoomForToggle();
                    customize.MarkSeeded(HostLabel(new Uri(pageUrl)));
                    if (pendingLesson != null) BeginInvoke(new Action(async () => { await Task.Delay(800); OpenPendingLesson(); }));
                    StartCapture();
                    return Reply(Snapshot());
                case "unsubscribe":
                    pageReady = false; return Empty;
                case "page-error":
                    var text = body.Text("message") ?? "";
                    Trace.WriteLine("rach3 JavaScript: " + text);
                    lock (pageErrors) pageErrors.Add(text);
                    customize.Tell("page-error", new Dictionary<string, object> { ["error"] = body });
                    return Empty;
                case "fullscreen":
                    ToggleFullscreen(); return Empty;
                case "update-state":
                    return Reply(updates.Snapshot());
                case "update-check":
                    updates.Check(); return Empty;
                case "update-read":
                    updates.Acknowledge(); return Empty;
                case "connect":
                case "scan":
                case "disconnect":
                case "output-start":
                case "output-stop":
                case "output-heartbeat":
                    return Reply(await bluetooth.Handle(command, body));
                case "lesson-state":
                    return Reply(lessons.Snapshot());
                case "lesson-tools":
                    return Reply(lessons.Tools());
                case "lesson-list":
                    try { return Reply(await customize.Ask("lesson-list", new Dictionary<string, object> { ["preview"] = false })); }
                    catch (NativeError) { return Reply(new List<object>()); }
                case "lesson-load":
                {
                    string lesson = null;
                    try { lesson = LessonText(await customize.Ask("lesson-load", new Dictionary<string, object> { ["id"] = body.Text("id") ?? "", ["preview"] = false })); }
                    catch (NativeError) { }
                    return lesson ?? throw new UserError("Bu ders burada yok.");
                }
                case "lesson-delete":
                {
                    // Changed code may run on this page, so it can delete only what is visible here,
                    // and the person's own lessons only from the original rach3.
                    var identifier = body.Text("id") ?? "";
                    object result;
                    try { result = await customize.Ask("lesson-delete", new Dictionary<string, object> { ["id"] = identifier }); }
                    catch (NativeError refusal)
                    {
                        throw new UserError(refusal.Message == "original-only" ? "Kendi derslerini orijinal rach3’ten silebilirsin." : "Bu ders burada yok.");
                    }
                    if (!((result as Dictionary<string, object>)?.Flag("personal", false) ?? false)) return Empty;
                    lessons.Delete(identifier);
                    return Reply(new Dictionary<string, object> { ["ok"] = true });
                }
                case "lesson-begin":
                    return Reply(lessons.Begin(body));
                case "lesson-chunk":
                    lessons.Append(body.Text("data"), body.Text("id"));
                    return Reply(new Dictionary<string, object> { ["ok"] = true });
                case "lesson-start":
                    lessons.Start(body.Text("id"));
                    return Reply(new Dictionary<string, object> { ["ok"] = true });
                case "lesson-cancel":
                    lessons.Cancel(); return Empty;
                case "desk-state":
                    return Reply(await AskCore("desk-state"));
                case "desk-stop":
                    return Reply(await AskCore("desk-stop"));
                case "desk-video-place":
                    PlaceVideo(body); return Empty;
                case "desk-video-close":
                    CloseVideo(); return Empty;
                case "desk-send":
                    var message = body.Text("text") ?? "";
                    if (message.Trim().Length == 0) throw new UserError("empty");
                    return Reply(await AskCore("desk-send", new Dictionary<string, object> { ["text"] = message }));
                case "desk-make":
                    return Reply(await AskCore("desk-make", new Dictionary<string, object> { ["card"] = body.TryGetValue("card", out var made) ? made : "" }));
                case "desk-clear":
                    return Reply(await AskCore("desk-clear"));
                case "desk-play":
                {
                    var card = customize.DeskCard(body.Text("card"));
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
                }
                case "desk-sign-in":
                    if (!panelOpen) ToggleCustomize();
                    return Empty;
                default:
                    throw new UserError("Unknown command");
            }
        }

        /// <summary>What the hidden preview may ask: reading only. Nothing it does reaches the piano or lessons.</summary>
        async Task<object> PreviewReply(Dictionary<string, object> body)
        {
            switch (body.Text("command"))
            {
                case "get-language": return new Dictionary<string, object> { ["language"] = Localization.Language };
                case "subscribe": return Snapshot();
                case "update-state": return updates.Snapshot();
                case "lesson-state": return lessons.Snapshot();
                case "lesson-tools": return lessons.Tools();
                case "lesson-list":
                    try { return await customize.Ask("lesson-list", new Dictionary<string, object> { ["preview"] = true }); }
                    catch (NativeError) { return new List<object>(); }
                case "lesson-load":
                    try
                    {
                        var text = LessonText(await customize.Ask("lesson-load", new Dictionary<string, object> { ["id"] = body.Text("id") ?? "", ["preview"] = true }));
                        return text != null ? Json.Object(text) : new Dictionary<string, object>();
                    }
                    catch (NativeError) { return new Dictionary<string, object>(); }
                default: return new Dictionary<string, object>();
            }
        }
    }
}
