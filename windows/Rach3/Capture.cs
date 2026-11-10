using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

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

        /// <summary>Runs JavaScript in the page (or the panel) that sets window.__pianoCheck, and waits for its JSON result.</summary>
        async Task<Dictionary<string, object>> PageCheck(string body, WebView2 view = null)
        {
            var core = (view ?? web).CoreWebView2;
            await core.ExecuteScriptAsync("window.__pianoCheck = null; (async () => { try { window.__pianoCheck = await (async () => {" + body +
                "})(); } catch (error) { window.__pianoCheck = { error: String(error && error.message || error) }; } })();");
            for (var attempt = 0; attempt < 240; attempt++)
            {
                if (Json.Parse(await core.ExecuteScriptAsync("JSON.stringify(window.__pianoCheck)")) is string text && text != "null")
                    return Json.Object(text) ?? new Dictionary<string, object> { ["value"] = Json.Parse(text) };
                await Task.Delay(500);
            }
            throw new TimeoutException("A check did not finish: " + body);
        }

        async Task<T> Until<T>(Func<Task<T>> read, Func<T, bool> done, int seconds, string what)
        {
            var end = DateTime.UtcNow.AddSeconds(seconds);
            while (true)
            {
                var value = await read();
                if (done(value)) return value;
                if (DateTime.UtcNow > end) throw new TimeoutException(what + ": " + Json.Write(value));
                await Task.Delay(1000);
            }
        }

        static Dictionary<string, object> Place(string area, string path) => new Dictionary<string, object> { ["area"] = area, ["path"] = path };

        /// <summary>
        /// The ChatGPT features on a real Windows machine, as on the Mac: the "With AI" tab, the
        /// box around Codex, candidates' files next to the page, the hidden preview, and a whole
        /// change made through the Customize panel with the bundled Codex in its box, talking to
        /// a stand-in for OpenAI. No ChatGPT account is used.
        /// </summary>
        async Task ChatGptSelfTest()
        {
            var report = new Dictionary<string, object>();
            try { await ChatGptChecks(report); }
            finally { File.WriteAllText(Path.Combine(options.Capture, "chatgpt-self-test.json"), Json.Write(report)); }
        }

        async Task ChatGptChecks(Dictionary<string, object> report)
        {
            if (panel == null) throw new InvalidOperationException("The Customize panel did not start");
            await Script("document.getElementById('source-ai')?.click();");
            await Task.Delay(1000);
            var page = await PageCheck("return { chat: document.documentElement.dataset.lessonChat || '', tab: !document.getElementById('source-ai').hidden, " +
                "state: document.getElementById('ai-source')?.dataset.state || '', text: document.getElementById('ai-source')?.innerText || '' };");
            report["page"] = page;
            await Shot("with-ai.png");

            var box = await Task.Run(() => customize.SelfTestBox());
            report["box"] = box;

            var cards = await customize.SelfTestCards(options.SelfTestPdf);
            report["cards"] = cards;
            var card = cards.TryGetValue("pdfCard", out var made) ? made as Dictionary<string, object> : null;
            Dictionary<string, object> served = null;
            if (card != null)
            {
                served = await PageCheck("const id = " + Json.Write(card.Text("id")) + "; const out = {};" +
                    "for (const name of ['page-1.png', 'large-1.png', 'nothing.png', '..%2F..%2Fdesk.json']) {" +
                    "  const response = await fetch('/_desk/' + id + '/' + name);" +
                    "  out[name] = response.status + ' ' + (response.headers.get('content-type') || '') + ' ' + (await response.arrayBuffer()).byteLength; }" +
                    "out.unknownCard = (await fetch('/_desk/000000000000/page-1.png')).status;" +
                    "out.internet = await fetch('https://example.com/', { mode: 'no-cors' }).then(response => 'reached ' + response.status, () => 'blocked');" +
                    "const image = new Image(); image.src = '/_desk/' + id + '/page-1.png';" +
                    "out.width = await new Promise(resolve => { image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve(0); });" +
                    "return out;");
                report["served"] = served;
            }

            // The hidden preview opens a copy of the page, runs a script there and takes a picture.
            await customize.Native(new Dictionary<string, object> { ["op"] = "remove", ["area"] = "data", ["path"] = "workspace" });
            await customize.Native(new Dictionary<string, object> { ["op"] = "open-workspace" });
            await customize.Native(new Dictionary<string, object> { ["op"] = "copy", ["from"] = Place("source", ""), ["to"] = Place("data", "workspace") });
            var preview = await RunPreview("return document.title + ' ' + window.PianoPlatform + ' ' + !!window.webkit.messageHandlers.rach3;");
            await customize.Native(new Dictionary<string, object> { ["op"] = "remove", ["area"] = "data", ["path"] = "workspace" });
            report["preview"] = new Dictionary<string, object>
            {
                ["scriptResult"] = preview.Text("scriptResult"), ["errors"] = preview.TryGetValue("errors", out var previewErrors) ? previewErrors : null,
                ["imageBytes"] = (preview.Text("image") ?? "").Length * 3 / 4, ["timedOut"] = preview.Flag("timedOut", false), ["snapshotError"] = preview.Text("snapshotError"),
            };

            // A whole change: ChatGPT (the stand-in) writes a file and breaks a protected one with
            // the shell in the box; rach3 checks the copy, restores what is protected and saves
            // it as a new version on a new branch, which goes on screen with the page's settings.
            var original = pageUrl;
            using (var standIn = new CustomizeService.StandIn("echo hello> customize-test.txt", "echo broken> AGENTS.md"))
            {
                Environment.SetEnvironmentVariable("RACH3_CODEX_UPSTREAM", standIn.Url);
                customize.SelfTestSignIn();
                await PageCheck("localStorage.setItem('rach3-seed-check', 'carried'); return {};");
                await PageCheck("window.rach3Customize.toggle(); return {};", panel);
                await Task.Delay(1000);
                report["send"] = await PageCheck("return await window.rach3Core.postMessage({ action: 'send', text: 'Add a test file' });", panel);
                try { await Change(report, standIn, original); }
                finally
                {
                    // What ChatGPT's stand-in saw, and what Codex said, for when the change goes wrong.
                    lock (standIn.Outputs) report["standInOutputs"] = standIn.Outputs.Cast<object>().ToList();
                    lock (standIn.Authorizations) report["standInRequests"] = standIn.Authorizations.Count;
                    try { report["finalState"] = await PageCheck("const s = await window.rach3Core.postMessage({ action: 'state' }); return JSON.parse(JSON.stringify(s, (k, v) => typeof v === 'string' && v.length > 400 ? v.slice(0, 400) : v));", panel); }
                    catch (Exception error) { report["finalState"] = error.Message; }
                    try { report["codexLog"] = string.Join("\n", CodexLogTail()); }
                    catch (Exception error) { report["codexLog"] = error.Message; }
                    if (!File.Exists(Path.Combine(options.Capture, "customize-panel.png")))
                        using (var file = File.Create(Path.Combine(options.Capture, "customize-panel-failed.png")))
                            await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
                }
            }
            Verdict(report, page, box, cards, card, served, preview, previewErrors);
        }

        /// <summary>The end of codex.log, which Codex is still writing.</summary>
        string[] CodexLogTail()
        {
            using (var stream = new FileStream(Path.Combine(paths.Logs, "codex.log"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream))
                return reader.ReadToEnd().Split('\n').Reverse().Take(60).Reverse().ToArray();
        }

        async Task Change(Dictionary<string, object> report, CustomizeService.StandIn standIn, string original)
        {
            {
                var state = await Until(() => PageCheck("const s = await window.rach3Core.postMessage({ action: 'state' });" +
                        "return { turn: !!s.turn, active: s.active, branch: s.branch, designs: s.designs };", panel),
                    value => value.Flag("turn", true) == false && Collections.AsList(value.TryGetValue("designs", out var list) ? list : null).Count > 0, 240, "The change did not finish");
                report["state"] = state;
                await Until(() => Task.FromResult(pageReady && pageUrl != original), ready => ready, 60, "The new version did not go on screen");
                await Task.Delay(2500);
                using (var file = File.Create(Path.Combine(options.Capture, "customize-panel.png")))
                    await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
                await Shot("customize-branch.png");
                report["branchPage"] = await PageCheck("return { href: location.href, test: (await fetch('/customize-test.txt')).status, " +
                    "agents: (await (await fetch('/AGENTS.md')).text()).slice(0, 30), seed: localStorage.getItem('rach3-seed-check') };");
                report["standIn"] = new Dictionary<string, object>
                {
                    ["authorizations"] = standIn.Authorizations.Distinct().Cast<object>().ToList(), ["outputs"] = standIn.Outputs.Cast<object>().ToList(),
                };
                await PageCheck("return await window.rach3Core.postMessage({ action: 'use-branch', branch: 'main' });", panel);
                await Until(() => Task.FromResult(pageReady && pageUrl == original), ready => ready, 60, "The original did not come back");
                report["backToOriginal"] = await PageCheck("return { href: location.href, test: (await fetch('/customize-test.txt')).status };");
            }
        }

        void Verdict(Dictionary<string, object> report, Dictionary<string, object> page, Dictionary<string, object> box, Dictionary<string, object> cards,
                     Dictionary<string, object> card, Dictionary<string, object> served, Dictionary<string, object> preview, object previewErrors)
        {

            bool Pass(object value) => value is Dictionary<string, object> checks && checks.Count > 0 && checks.Values.All(entry => (entry as string) == "pass");
            bool Image(string name) => served?.Text(name) is string line && line.StartsWith("200 image/png ", StringComparison.Ordinal) &&
                long.Parse(line.Substring(line.LastIndexOf(' ') + 1)) > 10000;
            var design = Collections.AsList(((Dictionary<string, object>)report["state"]).TryGetValue("designs", out var designs) ? designs : null)
                .OfType<Dictionary<string, object>>().LastOrDefault();
            var branchPage = (Dictionary<string, object>)report["branchPage"];
            var back = (Dictionary<string, object>)report["backToOriginal"];
            var standInReport = (Dictionary<string, object>)report["standIn"];
            var problems = new List<string>();
            void Check(bool ok, string what) { if (!ok) problems.Add(what); }
            Check(page.Text("chat") == "1" && page.Flag("tab", false) && page.Text("state") == "signed-out", "With AI tab");
            Check(Pass(box) && box.Count == 8, "box");
            Check(cards.Flag("refusesHttp", false) && cards.Flag("youtubeId", false), "cards");
            Check(card != null && card.Number("pageCount") >= 1 && Image("page-1.png") && Image("large-1.png") &&
                  served.Text("nothing.png")?.StartsWith("404", StringComparison.Ordinal) == true &&
                  served.Text("..%2F..%2Fdesk.json")?.StartsWith("404", StringComparison.Ordinal) == true &&
                  served.Number("unknownCard") == 404 && served.Number("width") > 500, "desk files");
            Check(served?.Text("internet") == "blocked", "page reaches no internet");
            Check(preview.Text("scriptResult")?.StartsWith("rach3 windows true", StringComparison.Ordinal) == true &&
                  Collections.AsList(previewErrors).Count == 0 && (preview.Text("image") ?? "").Length > 13000, "hidden preview");
            Check(design != null && Collections.AsList(design["files"]).Contains("customize-test.txt") &&
                  Collections.AsList(design["restored"]).Contains("AGENTS.md") && Collections.AsList(design["errors"]).Count == 0, "saved version");
            Check(branchPage.Text("href") != null && !branchPage.Text("href").StartsWith("https://" + Host + "/", StringComparison.Ordinal) &&
                  branchPage.Number("test") == 200 && branchPage.Text("agents")?.StartsWith("# rach3", StringComparison.Ordinal) == true &&
                  branchPage.Text("seed") == "carried", "branch page");
            Check(back.Text("href") == "https://" + Host + "/piano.html" && back.Number("test") == 404, "back to the original");
            Check(Collections.AsList(standInReport["authorizations"]).Cast<object>().All(value => (value as string) == "Bearer rach3-self-test") &&
                  Collections.AsList(standInReport["authorizations"]).Count == 1, "only rach3's relay holds the sign-in");
            if (problems.Count > 0) throw new InvalidOperationException("ChatGPT self-test failed (" + string.Join(", ", problems) + "): " + Json.Write(report));
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
