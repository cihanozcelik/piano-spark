using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace Rach3
{
    sealed partial class MainForm
    {
#if PIANO_CAPTURE
        // Development-only check of the real app renderer and bridge. Never in releases.
        bool captureStarted;

        void StartCapture()
        {
            if (options.Capture == null || captureStarted) return;
            captureStarted = true;
            BeginInvoke(new Action(async () =>
            {
                var code = 1;
                try { await RunCapture(); code = 0; }
                catch (Exception error) { File.WriteAllText(Path.Combine(options.Capture, "capture-error.txt"), error.ToString()); }
                lock (pageErrors)
                {
                    File.WriteAllLines(Path.Combine(options.Capture, "page-errors.txt"), pageErrors);
                    if (pageErrors.Count > 0) code = 1;
                }
                Environment.Exit(code);
            }));
        }

        async Task<string> Script(string code) => await web.CoreWebView2.ExecuteScriptAsync(code);

        async Task Shot(string name)
        {
            using (var file = File.Create(Path.Combine(options.Capture, name)))
                await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
        }

        async Task RunCapture()
        {
            Directory.CreateDirectory(options.Capture);
            if (!Ed25519.SelfTest()) throw new InvalidOperationException("Ed25519 verification failed the RFC 8032 vectors");
            const string ready = "window.PianoI18n?.language === 'en' && !!document.querySelector('#sheet-paper svg') && !document.getElementById('sheet-paper').hidden";
            for (var attempt = 0; ; attempt++)
            {
                if (await Script(ready) == "true") break;
                if (attempt >= 60) throw new TimeoutException("The score was not ready: " + await Script("document.getElementById('sheet-loading-text')?.textContent"));
                await Task.Delay(1000);
            }
            await Script("document.getElementById('tab-practice').click(); const seek=document.getElementById('seek'); seek.value=25; seek.dispatchEvent(new Event('input',{bubbles:true}));");
            await Task.Delay(2000);
            await Shot("practice.png");
            var banner = Json.Parse(await Script("(() => { const e = document.getElementById('error'); return e && !e.hidden ? e.textContent : ''; })()")) as string;
            if (!string.IsNullOrEmpty(banner)) throw new InvalidOperationException("The page shows an error: " + banner);
            await Script("document.getElementById('tab-create').click();");
            await Task.Delay(1500);
            await Shot("create-lesson.png");
            var mac = Json.Parse(await Script("(document.body.innerText.match(/[^\\n]*(\\bMac\\b|Mac’|macOS)[^\\n]*/) || [''])[0]")) as string;
            if (!string.IsNullOrEmpty(mac)) throw new InvalidOperationException("Mac wording on Windows: " + mac);
            await ChatGptSelfTest();
            if (options.SelfTestMidi != null) await SelfTest(options.SelfTestMidi);
        }

        /// <summary>Runs page JavaScript that sets window.__pianoCheck, and waits for its JSON result.</summary>
        async Task<Dictionary<string, object>> PageCheck(string body)
        {
            await Script("window.__pianoCheck = null; (async () => { try { window.__pianoCheck = await (async () => {" + body +
                "})(); } catch (error) { window.__pianoCheck = { error: String(error && error.message || error) }; } })();");
            for (var attempt = 0; attempt < 120; attempt++)
            {
                if (Json.Parse(await Script("JSON.stringify(window.__pianoCheck)")) is string text && text != "null") return Json.Object(text);
                await Task.Delay(500);
            }
            throw new TimeoutException("A page check did not finish: " + body);
        }

        /// <summary>
        /// The "With AI" tab on a real Windows machine: the tab is offered, the bundled Codex
        /// starts and opens a lesson conversation with rach3's tools, and a PDF candidate's
        /// pages reach the page through /_desk/. No ChatGPT account is used.
        /// </summary>
        async Task ChatGptSelfTest()
        {
            var report = new Dictionary<string, object>();
            await Script("document.getElementById('source-ai')?.click();");
            await Task.Delay(1000);
            report["page"] = await PageCheck("return { chat: document.documentElement.dataset.lessonChat || '', tab: !document.getElementById('source-ai').hidden, " +
                "state: document.getElementById('ai-source')?.dataset.state || '', text: document.getElementById('ai-source')?.innerText || '' };");
            await Shot("with-ai.png");
            report["codex"] = await chat.SelfTest();
            var cards = await chat.SelfTestCards(options.SelfTestPdf);
            report["cards"] = cards;
            var card = cards.TryGetValue("pdfCard", out var made) ? made as Dictionary<string, object> : null;
            if (card != null)
                report["served"] = await PageCheck("const id = " + Json.Write(card.Text("id")) + "; const out = {};" +
                    "for (const name of ['page-1.png', 'large-1.png', 'nothing.png', '..%2F..%2Fdesk.json']) {" +
                    "  const response = await fetch(window.PianoDeskFiles + '_desk/' + id + '/' + name);" +
                    "  out[name] = response.status + ' ' + (response.headers.get('content-type') || '') + ' ' + (await response.arrayBuffer()).byteLength; }" +
                    "out.unknownCard = (await fetch(window.PianoDeskFiles + '_desk/000000000000/page-1.png')).status; return out;");
            lock (deskRequests) report["deskRequests"] = deskRequests.ToList();
            if (card != null)
                report["image"] = await PageCheck("const image = new Image(); image.src = window.PianoDeskFiles + '_desk/' + " + Json.Write(card.Text("id")) + " + '/page-1.png';" +
                    "return await new Promise(resolve => { image.onload = () => resolve({ width: image.naturalWidth }); image.onerror = () => resolve({ error: 'load' }); });");
            var text = Json.Write(report);
            File.WriteAllText(Path.Combine(options.Capture, "chatgpt-self-test.json"), text);
            var page = (Dictionary<string, object>)report["page"];
            var codex = (Dictionary<string, object>)report["codex"];
            var served = report.TryGetValue("served", out var files) ? files as Dictionary<string, object> : null;
            bool Image(string name) => served?.Text(name) is string line && line.StartsWith("200 image/png ", StringComparison.Ordinal) &&
                long.Parse(line.Substring(line.LastIndexOf(' ') + 1)) > 10000;
            var ok = page.Text("chat") == "1" && page.Flag("tab", false) && page.Text("state") == "signed-out" &&
                codex.Flag("available", false) && codex.Text("started") == "ok" && codex.Flag("catalog", false) &&
                codex.Text("thread") is string thread && !thread.StartsWith("{", StringComparison.Ordinal) && codex.Flag("listLessons", false) &&
                codex.TryGetValue("box", out var box) && box is Dictionary<string, object> boxed && boxed.Count == 7 && boxed.Values.All(value => (value as string) == "pass") &&
                cards.Flag("refusesHttp", false) && cards.Flag("youtubeId", false) && card != null && card.Number("pageCount") >= 1 &&
                card.Number("width") > 500 && card.Number("height") > 100 && Image("page-1.png") && Image("large-1.png") &&
                served.Text("nothing.png")?.StartsWith("404", StringComparison.Ordinal) == true &&
                served.Text("..%2F..%2Fdesk.json")?.StartsWith("404", StringComparison.Ordinal) == true && served.Number("unknownCard") == 404 &&
                report.TryGetValue("image", out var image) && (image as Dictionary<string, object>).Number("width") > 500;
            if (!ok) throw new InvalidOperationException("ChatGPT self-test failed: " + text);
        }

        /// <summary>Create a lesson from a MIDI file through the page bridge, exactly as the UI does.</summary>
        async Task SelfTest(string midi)
        {
            var data = File.ReadAllBytes(midi);
            var chunks = new List<string>();
            for (var offset = 0; offset < data.Length; offset += 1024 * 1024)
                chunks.Add(Convert.ToBase64String(data, offset, Math.Min(1024 * 1024, data.Length - offset)));
            var request = Json.Write(new Dictionary<string, object>
            {
                ["command"] = "lesson-begin", ["name"] = Path.GetFileName(midi), ["kind"] = "midi", ["size"] = data.Length,
                ["title"] = "Şarkı ğüşıöç", ["tempo"] = 60, ["separate"] = false,
            });
            await Script(@"(async () => {
  const native = window.webkit.messageHandlers.rach3;
  try {
    const finished = new Promise(resolve => {
      const listener = event => {
        const detail = event.detail;
        if (detail.event === 'lesson-progress' && ['complete', 'error', 'cancelled'].includes(detail.phase)) {
          window.removeEventListener('rach3-native-event', listener); resolve(detail);
        }
      };
      window.addEventListener('rach3-native-event', listener);
    });
    const job = await native.postMessage(" + request + @");
    for (const data of " + Json.Write(chunks) + @") await native.postMessage({ command: 'lesson-chunk', id: job.id, data });
    await native.postMessage({ command: 'lesson-start', id: job.id });
    const done = await finished;
    if (done.phase !== 'complete') throw new Error(done.message);
    const list = await native.postMessage({ command: 'lesson-list' });
    const lesson = await native.postMessage({ command: 'lesson-load', id: done.id });
    let rejected = false;
    try { await native.postMessage({ command: 'lesson-load', id: 'not-a-lesson' }); } catch (error) { rejected = true; }
    window.__pianoSelfTest = { ok: true, noteCount: lesson.noteCount, title: lesson.title,
      listed: list.some(item => item.id === done.id), rejectsInvalid: rejected };
  } catch (error) {
    window.__pianoSelfTest = { ok: false, error: String(error && error.message || error) };
  }
})();");
            for (var attempt = 0; attempt < 900; attempt++)
            {
                var raw = await Script("JSON.stringify(window.__pianoSelfTest || null)");
                if (Json.Parse(raw) is string text && text != "null")
                {
                    File.WriteAllText(Path.Combine(options.Capture, "self-test.json"), text);
                    var result = Json.Object(text);
                    if (!result.Flag("ok", false) || !result.Flag("listed", false) || !result.Flag("rejectsInvalid", false) ||
                        result.Text("title") != "Şarkı ğüşıöç" || result.Number("noteCount") <= 0)
                        throw new InvalidOperationException("Self-test failed: " + text);
                    await Script("document.getElementById('tab-practice').click();");
                    await Task.Delay(1500);
                    await Shot("lesson-created.png");
                    return;
                }
                await Task.Delay(1000);
            }
            throw new TimeoutException("The self-test lesson did not finish");
        }
#else
        void StartCapture() { }
#endif
    }
}
