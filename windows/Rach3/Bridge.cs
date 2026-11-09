using System;
using System.Collections.Generic;
using System.Diagnostics;
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
  if (!webview || window.location.href !== '" + PageUrl + @"') return;
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
  window.addEventListener('error', e => rach3.postMessage({ command: 'page-error', message: e.message }));
})();";

        async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (args.Source != PageUrl) return;
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

        async Task<string> Dispatch(Dictionary<string, object> body)
        {
            var command = body.Text("command");
            switch (command)
            {
                case "get-language":
                    return Reply(new Dictionary<string, object> { ["language"] = Localization.Language });
                case "set-language":
                    var language = body.Text("language");
                    if (language != "en" && language != "tr") throw new UserError("Desteklenmeyen dil.");
                    Localization.Language = language;
                    BeginInvoke(new Action(() =>
                    {
                        Publish(new Dictionary<string, object> { ["event"] = "language", ["language"] = language });
                        Publish(Snapshot()); Publish(updates.Snapshot()); Publish(lessons.Snapshot());
                    }));
                    return Reply(new Dictionary<string, object> { ["language"] = language });
                case "subscribe":
                    pageReady = true;
                    Trace.WriteLine("rach3 page ready");
                    StartCapture();
                    return Reply(Snapshot());
                case "unsubscribe":
                    pageReady = false; return Empty;
                case "page-error":
                    var text = body.Text("message") ?? "";
                    Trace.WriteLine("rach3 JavaScript: " + text);
                    lock (pageErrors) pageErrors.Add(text);
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
                    return Reply(lessons.Lessons());
                case "lesson-load":
                    return lessons.LessonJson(body.Text("id"));
                case "lesson-delete":
                    lessons.Delete(body.Text("id"));
                    return Reply(new Dictionary<string, object> { ["ok"] = true });
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
                default:
                    throw new UserError("Unknown command");
            }
        }
    }
}
