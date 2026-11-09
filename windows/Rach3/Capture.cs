using System;
using System.Collections.Generic;
using System.IO;
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
            if (options.SelfTestMidi != null) await SelfTest(options.SelfTestMidi);
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
