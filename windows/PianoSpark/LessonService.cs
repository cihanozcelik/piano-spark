using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace PianoSpark
{
    /// <summary>
    /// Port of desktop/LessonService.m. One lesson job at a time: the page uploads the
    /// input in chunks, then the bundled Python worker runs in a kill-on-close job object.
    /// The worker contract is the one windows/engine.py documents and CI verifies.
    /// </summary>
    sealed class LessonService
    {
        const string Catalog = "tools-win_amd64.json";
        readonly Paths paths;
        readonly SynchronizationContext ui;
        Dictionary<string, object> state = Idle();
        string identifier, jobDirectory;
        FileStream upload;
        Process task;
        ProcessGroup group;
        bool cancelling;
        long expectedSize, uploadedSize;

        public Action<Dictionary<string, object>> OnEvent;
        public Action OnIdle;

        public LessonService(Paths paths)
        {
            this.paths = paths;
            ui = SynchronizationContext.Current;
            var jobs = Path.Combine(paths.Support, "Jobs");
            if (!Directory.Exists(jobs)) return;
            foreach (var old in Directory.GetDirectories(jobs))
            {
                int.TryParse(ReadOrNull(Path.Combine(old, "owner.pid")), out var pid);
                if (!Alive(pid)) Files.Delete(old);
            }
        }

        static Dictionary<string, object> Idle() => Progress("idle", "", 0);

        static Dictionary<string, object> Progress(string phase, string message, double progress) =>
            new Dictionary<string, object> { ["event"] = "lesson-progress", ["phase"] = phase, ["message"] = message, ["progress"] = progress };

        static string ReadOrNull(string path) { try { return Files.Read(path).Trim(); } catch (Exception) { return null; } }

        static bool Alive(int pid)
        {
            if (pid <= 0) return false;
            try { using (var process = Process.GetProcessById(pid)) return !process.HasExited; }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        public bool Running => identifier != null;
        string Library => Path.Combine(paths.Support, "Lessons");
        public Dictionary<string, object> Snapshot() => Localization.Status(state);

        public Dictionary<string, object> Tools()
        {
            var catalog = Json.Object(Files.Read(Path.Combine(paths.Engine, Catalog)));
            var artifacts = new Dictionary<string, object>();
            foreach (var entry in (Dictionary<string, object>)catalog["artifacts"])
            {
                var artifact = ((Dictionary<string, object>)entry.Value).Copy();
                var hash = artifact.Text("sha256");
                // tools_manager.short(): Windows artifact folders use 24 hex digits.
                var marker = Path.Combine(paths.Tools, "a", hash.Substring(0, 24), ".ready");
                artifact["ready"] = ReadOrNull(marker) == hash;
                var partial = new FileInfo(Path.Combine(paths.Tools, "downloads", hash + ".part"));
                artifact["received"] = Math.Min(partial.Exists ? partial.Length : 0, artifact.Number("size"));
                artifacts[entry.Key] = artifact;
            }
            return new Dictionary<string, object> { ["groups"] = catalog["groups"], ["artifacts"] = artifacts };
        }

        void Publish(Dictionary<string, object> next)
        {
            state = next;
            try { Files.WriteAtomic(Path.Combine(paths.Support, "LastJob.json"), Json.Write(next)); }
            catch (IOException) { }
            OnEvent?.Invoke(Snapshot());
        }

        public List<Dictionary<string, object>> Lessons()
        {
            var list = new List<Dictionary<string, object>>();
            if (!Directory.Exists(Library)) return list;
            foreach (var file in Directory.GetFiles(Library, "*.json"))
            {
                Dictionary<string, object> lesson = null;
                try { lesson = Json.Object(Files.Read(file)); } catch (Exception) { }
                if (lesson == null || !lesson.ContainsKey("id") || !lesson.ContainsKey("title")) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["id"] = lesson["id"], ["title"] = lesson["title"],
                    ["noteCount"] = lesson.TryGetValue("noteCount", out var count) ? count : 0,
                });
            }
            list.Sort((a, b) => string.Compare(a["title"] as string, b["title"] as string, StringComparison.CurrentCultureIgnoreCase));
            return list;
        }

        static string Checked(string identifier)
        {
            if (!Guid.TryParseExact(identifier ?? "", "D", out _)) throw new UserError("Geçersiz ders kimliği");
            return identifier;
        }

        /// <summary>The saved lesson as raw JSON; it goes to the page unchanged.</summary>
        public string LessonJson(string id) => Files.Read(Path.Combine(Library, Checked(id) + ".json"));

        public void Delete(string id)
        {
            Checked(id);
            File.Delete(Path.Combine(Library, id + ".json"));
            var assets = Path.Combine(Library, id + ".assets");
            if (Directory.Exists(assets)) Directory.Delete(assets, true);
            if (state.Text("id") == id) Publish(Idle());
        }

        public Dictionary<string, object> Begin(Dictionary<string, object> request)
        {
            if (Running) throw new UserError("Önce mevcut işlemi tamamla veya iptal et.");
            var name = request.Text("name") ?? "video.mp4";
            var title = request.Text("title") ?? Path.GetFileNameWithoutExtension(name);
            var url = request.Text("url") ?? "";
            if (url.Length > 0)
            {
                if (!Uri.TryCreate(url, UriKind.Absolute, out var parts) || parts.Scheme != "https" || parts.Host != "www.youtube.com" ||
                    parts.AbsolutePath != "/watch" || parts.UserInfo.Length > 0 || !parts.IsDefaultPort)
                    throw new UserError("Geçerli bir YouTube bağlantısı seç.");
            }
            expectedSize = request.Number("size");
            if (expectedSize > 4L * 1024 * 1024 * 1024) throw new UserError("En fazla 4 GB video seçebilirsin.");
            identifier = Guid.NewGuid().ToString("D").ToUpperInvariant();
            jobDirectory = Path.Combine(paths.Support, "Jobs", identifier);
            cancelling = false; uploadedSize = 0;
            try
            {
                Directory.CreateDirectory(jobDirectory);
                File.WriteAllText(Path.Combine(jobDirectory, "owner.pid"), Process.GetCurrentProcess().Id.ToString());
                var kind = request.Text("kind") == "pdf" ? "pdf" : request.Text("kind") == "midi" ? "midi" : "video";
                var input = "input." + kind;
                var job = new Dictionary<string, object>
                {
                    ["id"] = identifier, ["title"] = title, ["input"] = input, ["kind"] = kind, ["sourceName"] = name,
                    ["tempo"] = request.TryGetValue("tempo", out var tempo) && tempo != null ? tempo : 60,
                    ["url"] = url, ["separate"] = request.Flag("separate", true),
                };
                Files.WriteAtomic(Path.Combine(jobDirectory, "request.json"), Json.Write(job));
                if (url.Length == 0) upload = new FileStream(Path.Combine(jobDirectory, input), FileMode.CreateNew, FileAccess.Write);
            }
            catch (Exception)
            {
                Cancel(); throw;
            }
            var progress = Progress("upload", "Dosya hazırlanıyor…", 0);
            progress["title"] = title;
            Publish(progress);
            return new Dictionary<string, object> { ["id"] = identifier };
        }

        public void Append(string encoded, string id)
        {
            if (id != identifier || upload == null) throw new UserError("Video aktarımı kapalı.");
            byte[] data;
            try { data = Convert.FromBase64String(encoded ?? ""); } catch (FormatException) { data = null; }
            if (data == null || data.Length > 2 * 1024 * 1024 || uploadedSize + data.Length > expectedSize)
                throw new UserError("Video aktarım boyutu geçersiz.");
            upload.Write(data, 0, data.Length);
            uploadedSize += data.Length;
        }

        public void Start(string id)
        {
            if (id != identifier || task != null) throw new UserError("Ders işlemi bulunamadı.");
            if (upload != null && uploadedSize != expectedSize) throw new UserError("Video aktarımı tamamlanmadı.");
            upload?.Dispose(); upload = null;
            var python = Path.Combine(paths.Engine, "python", "python.exe");
            if (!File.Exists(python)) { Cancel(); throw new UserError("Ders motoru bu bilgisayarda bulunamadı. Rach3’ü yeniden yükle."); }
            var temp = Path.Combine(jobDirectory, "tmp");
            Directory.CreateDirectory(temp);
            var start = new ProcessStartInfo(python, Files.Arguments(new[]
            {
                "-u", Path.Combine(paths.Engine, "worker.py"), "--job", jobDirectory, "--tools", paths.Tools,
                "--library", Library, "--parent", Process.GetCurrentProcess().Id.ToString(),
            }))
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = jobDirectory,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false),
            };
            var system = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
            var environment = start.EnvironmentVariables;
            environment["PYTHONHOME"] = Path.Combine(paths.Engine, "python");
            environment["PYTHONPATH"] = paths.Engine;
            environment["PYTHONNOUSERSITE"] = "1"; environment["PYTHONDONTWRITEBYTECODE"] = "1";
            // JSON events and lesson files are UTF-8, not the ANSI code page.
            environment["PYTHONUTF8"] = "1"; environment["PYTHONIOENCODING"] = "utf-8";
            environment["PATH"] = Path.Combine(system, "System32") + ";" + system;
            environment["TEMP"] = temp; environment["TMP"] = temp;

            Directory.CreateDirectory(paths.Logs);
            var log = new StreamWriter(Path.Combine(paths.Logs, "lesson.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
            var process = new Process { StartInfo = start };
            process.ErrorDataReceived += (sender, line) => { if (line.Data != null) lock (log) log.WriteLine(line.Data); };
            var processGroup = new ProcessGroup();
            try
            {
                process.Start();
                processGroup.Add(process);
            }
            catch (Exception)
            {
                processGroup.Terminate(); processGroup.Dispose(); log.Dispose(); Cancel(); throw;
            }
            process.BeginErrorReadLine();
            task = process; group = processGroup;
            Publish(Progress("starting", "Ders motoru başlatılıyor…", 0));
            var reader = new Thread(() =>
            {
                string line;
                while ((line = process.StandardOutput.ReadLine()) != null)
                {
                    if (!line.StartsWith("{", StringComparison.Ordinal)) continue;
                    Dictionary<string, object> message = null;
                    try { message = Json.Object(line); } catch (Exception) { }
                    if (message?.Text("event") != "lesson-progress") continue;
                    ui.Post(_ =>
                    {
                        if (task != process || cancelling) return;
                        var phase = message.Text("phase");
                        if (phase == "complete" || phase == "error") state = message;
                        else Publish(message);
                    }, null);
                }
                process.WaitForExit();
                lock (log) log.Dispose();
                ui.Post(_ => Finished(process), null);
            }) { IsBackground = true, Name = "Lesson worker output" };
            reader.Start();
        }

        void Finished(Process process)
        {
            if (task != process) return;
            var finished = identifier;
            task = null; identifier = null;
            group?.Dispose(); group = null;
            process.Dispose();
            Files.Delete(jobDirectory); jobDirectory = null;
            var phase = state.Text("phase");
            if (cancelling)
            {
                Files.Delete(Path.Combine(Library, finished + ".json"));
                Publish(Progress("cancelled", "İşlem iptal edildi", 0));
            }
            else if (phase == "complete" || phase == "error") Publish(state);
            else Publish(Progress("error", "Ders oluşturulamadı. İşlem beklenmedik şekilde kapandı.", 0));
            OnIdle?.Invoke();
        }

        public void OpenVideo(string path)
        {
            var size = new FileInfo(path).Length;
            var job = Begin(new Dictionary<string, object> { ["name"] = Path.GetFileName(path), ["size"] = size, ["separate"] = true });
            upload?.Dispose(); upload = null;
            var input = Path.Combine(jobDirectory, "input.video");
            try { File.Copy(path, input, true); }
            catch (Exception) { Cancel(); throw; }
            uploadedSize = size;
            Start((string)job["id"]);
        }

        public void Cancel()
        {
            cancelling = true;
            if (task != null)
            {
                group?.Terminate();
                Publish(Progress("cancelling", "İşlem durduruluyor…", 0));
            }
            else if (identifier != null)
            {
                upload?.Dispose(); upload = null;
                Files.Delete(jobDirectory);
                identifier = null; jobDirectory = null;
                Publish(Progress("cancelled", "İşlem iptal edildi", 0));
                OnIdle?.Invoke();
            }
        }
    }
}
