using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Rach3
{
    /// <summary>An answer core.js gets as an error ("invalid", "restarted", …), never shown as is.</summary>
    sealed class NativeError : Exception
    {
        public NativeError(string code) : base(code) { }
    }

    /// <summary>
    /// The Windows side of rach3's ChatGPT features, the counterpart of desktop/CustomizeService.m.
    /// What they do, for changing rach3 and for the "With AI" tab, is desktop/customize/core.js,
    /// shared with the Mac; it runs in the Customize panel and asks this class for what only
    /// Windows can do: files in rach3's own folders, Codex inside its box, Sign in with ChatGPT,
    /// the hidden preview and serving the page. Data lives where the Mac keeps it, in
    /// %LOCALAPPDATA%\Rach3\Customize.
    /// </summary>
    sealed partial class CustomizeService
    {
        // Sign in with ChatGPT, direct flow for open-source apps
        // (developers.openai.com/siwc/token-sharing-open-source).
        const string AuthorizeUrl = "https://auth.openai.com/api/accounts/authorize";
        const string TokenUrl = "https://auth.openai.com/api/accounts/oauth/token";
        const string RevokeUrl = "https://auth.openai.com/api/accounts/oauth/revoke";
        const string UsageUrl = "https://chatgpt.com/settings/usage";
        const string Resource = "https://api.openai.com/v1";
        const string Scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
        const string PlanScope = "chatgpt.tokens.use.direct";
        static readonly string[] ExpiredCodes =
        {
            "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
        };
        // What core.js may reach in Customize: its records, the saved versions, the scratch
        // copy and the lessons ChatGPT made. Not the sign-in, not Codex's home.
        static readonly HashSet<string> DataEntries = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "designs.json", "usage.json", "designs", "workspace", "lessons",
        };

        readonly string source, codexRoot, root, support, version, logs;
        readonly SynchronizationContext ui;
        readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        readonly LessonDesk desk;
        Dictionary<string, object> session, preferences;

        // what is on screen, as core.js last said
        string activeDesign = "original";
        /// <summary>The page's host label: "app" for the original rach3, else the branch's.</summary>
        public string PageHost { get; private set; } = "app";

        // core.js
        bool coreReady;
        readonly List<Dictionary<string, object>> coreQueue = new List<Dictionary<string, object>>();
        readonly Dictionary<long, TaskCompletionSource<object>> answers = new Dictionary<long, TaskCompletionSource<object>>();
        long nextQuestion;

        // sign-in
        TcpListener listener;
        bool signingIn;
        string signInError;
        Task<string> refreshing;

        // Codex app-server, in its box
        BoxedProcess codex;
        ProcessGroup codexGroup;
        CodexRelay relay;
        Stream codexInput;
        string codexToken;

        /// <summary>Delivers a message to core.js (window.rach3Core.receive in the panel).</summary>
        public Action<Dictionary<string, object>> OnCore;
        /// <summary>core.js put a design on screen; true when the panel just loaded.</summary>
        public Action<bool> OnShow;
        /// <summary>The panel opened or closed; the second value is its button's width.</summary>
        public Action<bool, double> OnPanel;
        /// <summary>Opens the scratch copy in the hidden preview and runs a script there.</summary>
        public Func<string, Task<Dictionary<string, object>>> Preview;
        /// <summary>A lesson was created or changed for the person.</summary>
        public Action<Dictionary<string, object>> OnLessonChanged;
        /// <summary>Events of the "With AI" tab, for the page.</summary>
        public Action<Dictionary<string, object>> OnDeskEvent;
        /// <summary>Starts a lesson with rach3's own import: kind, file, link, title in; job or error out.</summary>
        public Func<Dictionary<string, object>, Dictionary<string, object>> ImportLesson;
        /// <summary>Bytes of tools a lesson of that kind still needs to download.</summary>
        public Func<string, long> MissingTools;
        /// <summary>Sign-in finished in the browser: rach3 comes forward.</summary>
        public Action OnSignedIn;

        public CustomizeService(Paths paths, string version)
        {
            this.version = version ?? "";
            ui = SynchronizationContext.Current;
            source = Path.Combine(paths.Resources, "Source");
            var development = Environment.GetEnvironmentVariable("RACH3_CODEX_ROOT");
            codexRoot = string.IsNullOrEmpty(development) ? Path.Combine(paths.App, "Codex") : development;
            support = paths.Support;
            logs = paths.Logs;
            root = Path.Combine(paths.Support, "Customize");
            Directory.CreateDirectory(Path.Combine(root, "designs"));
            session = Load("session.json");
            preferences = Load("preferences.json");
            desk = new LessonDesk(Path.Combine(root, "desk"));
            desk.OnProgress = progress =>
            {
                var update = progress.Copy();
                update["event"] = "desk-progress";
                OnDeskEvent?.Invoke(update);
            };
        }

        #region Storage

        Dictionary<string, object> Load(string name)
        {
            try { return Json.Object(Files.Read(Path.Combine(root, name))) ?? new Dictionary<string, object>(); }
            catch (Exception) { return new Dictionary<string, object>(); }
        }

        void Save(Dictionary<string, object> value, string name)
        {
            try { Files.WriteAtomic(Path.Combine(root, name), Json.Write(value)); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        string Workspace => Path.Combine(root, "workspace");
        string LessonsFolder => Path.Combine(support, "Lessons");
        string CodexHome => Path.Combine(root, "codex");
        string CodexBinary => Path.Combine(codexRoot, "bin", "codex.exe");

        /// <summary>Whether this copy of rach3 carries Codex, so ChatGPT features can be offered.</summary>
        public bool Available => File.Exists(CodexBinary);

        string ActiveRoot
        {
            get
            {
                if (activeDesign == "original") return source;
                var folder = Inside(Path.Combine(root, "designs"), activeDesign);
                return folder != null && Directory.Exists(folder) ? folder : source;
            }
        }

        /// <summary>The page's address. Each branch has its own host, so its stored settings are its own.</summary>
        public string PageUrl => PageUrlOf(PageHost ?? "app");
        public static string PageUrlOf(string host) => "https://" + (host == "app" ? "" : host + ".") + MainForm.Host + "/piano.html";

        /// <summary>A branch opened for the first time starts with the settings of the page it was opened from, copied once.</summary>
        public bool NeedsSeed(string host) =>
            host != "app" && !Collections.AsList(preferences.TryGetValue("seeded", out var seeded) ? seeded : null).Contains(host);

        public void MarkSeeded(string host)
        {
            if (host == null || !NeedsSeed(host)) return;
            var list = Collections.AsList(preferences.TryGetValue("seeded", out var seeded) ? seeded : null).Cast<object>().ToList();
            list.Add(host); preferences["seeded"] = list; Save(preferences, "preferences.json");
        }

        #endregion

        #region Paths

        static readonly char[] Forbidden = Path.GetInvalidFileNameChars().Concat(new[] { ':', '\\', '/', '*', '?', '"', '<', '>', '|' }).ToArray();
        static readonly HashSet<string> Devices = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        };

        static bool IsLink(string path)
        {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is NotSupportedException)
            {
                return false;
            }
        }

        /// <summary>
        /// A relative path ("a/b.js") inside root, or null when it would leave it: no "..", no
        /// hidden names, no names Windows reads differently, and no link or junction on the way,
        /// since one could lead anywhere on the computer.
        /// </summary>
        public static string Inside(string root, string path)
        {
            if (path == null || path.StartsWith("/", StringComparison.Ordinal)) return null;
            if (path.Length == 0) return root;
            var current = root;
            foreach (var part in path.Split('/'))
            {
                if (part.Length == 0 || part[0] == '.' || part.IndexOfAny(Forbidden) >= 0 || part.EndsWith(" ", StringComparison.Ordinal) ||
                    part.EndsWith(".", StringComparison.Ordinal) || Devices.Contains(part.Split('.')[0].TrimEnd(' '))) return null;
                current = Path.Combine(current, part);
                if (IsLink(current)) return null;
            }
            return current;
        }

        /// <summary>Regular files under folder, as "/"-separated paths relative to it. Links and junctions are skipped, never followed.</summary>
        static List<string> RelativeFiles(string folder)
        {
            var paths = new List<string>();
            void Walk(string directory, string prefix)
            {
                DirectoryInfo info;
                FileSystemInfo[] entries;
                try { info = new DirectoryInfo(directory); entries = info.GetFileSystemInfos(); }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException) { return; }
                foreach (var entry in entries)
                {
                    if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                    var name = prefix + entry.Name;
                    if ((entry.Attributes & FileAttributes.Directory) != 0) Walk(entry.FullName, name + "/");
                    else paths.Add(name);
                }
            }
            if (Directory.Exists(folder) && !IsLink(folder)) Walk(folder, "");
            return paths;
        }

        string Location(object raw, bool write)
        {
            if (!(raw is Dictionary<string, object> place)) return null;
            var area = place.Text("area");
            var path = place.Text("path");
            if (area == null || path == null) return null;
            string folder = null;
            if (area == "source" && !write) folder = source;
            else if (area == "lessons") folder = LessonsFolder;
            else if (area == "data")
            {
                if (!DataEntries.Contains(path.Split('/')[0])) return null;
                folder = root;
            }
            return folder == null ? null : Inside(folder, path);
        }

        static bool SamePath(string a, string b) =>
            string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

        static bool CopyFrom(string from, string to)
        {
            if (from == null || to == null || IsLink(from)) return false;
            try
            {
                if (File.Exists(from))
                {
                    Files.Delete(to);
                    Directory.CreateDirectory(Path.GetDirectoryName(to));
                    File.Copy(from, to);
                    return true;
                }
                if (!Directory.Exists(from)) return false;
                Directory.CreateDirectory(to);
                foreach (var path in RelativeFiles(from))
                {
                    var target = Path.Combine(to, path.Replace('/', '\\'));
                    Files.Delete(target);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    // A copy takes its permissions from where it lands, not from where it came from.
                    File.Copy(Path.Combine(from, path.Replace('/', '\\')), target);
                }
                return true;
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is NotSupportedException)
            {
                return false;
            }
        }

        /// <summary>
        /// Moves by copying and deleting: the scratch copy carries the box's permission to change
        /// it, which a saved version must not keep, and a copy takes its permissions from where it lands.
        /// </summary>
        static bool Move(string from, string to)
        {
            if (from == null || to == null || File.Exists(to) || Directory.Exists(to) || (!File.Exists(from) && !Directory.Exists(from))) return false;
            try { Directory.CreateDirectory(Path.GetDirectoryName(to)); }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { return false; }
            if (!CopyFrom(from, to)) { Files.Delete(to); return false; }
            Files.Delete(from);
            return true;
        }

        static void Trash(string path)
        {
            try
            {
                if (Directory.Exists(path))
                    Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(path, Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                        Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
                else if (File.Exists(path))
                    Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(path, Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                        Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is OperationCanceledException ||
                                          error is InvalidOperationException) { }
        }

        static List<object> Summaries(string folder)
        {
            var list = new List<object>();
            if (!Directory.Exists(folder)) return list;
            foreach (var file in Directory.GetFiles(folder, "*.json"))
            {
                if (IsLink(file)) continue;
                Dictionary<string, object> lesson = null;
                try { lesson = Json.Object(Files.Read(file)); } catch (Exception) { }
                if (lesson == null || !lesson.ContainsKey("id") || !lesson.ContainsKey("title")) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["id"] = lesson["id"], ["title"] = lesson["title"],
                    ["noteCount"] = lesson.TryGetValue("noteCount", out var notes) ? notes : 0,
                    ["duration"] = lesson.TryGetValue("duration", out var duration) ? duration : 0,
                });
            }
            return list;
        }

        #endregion

        #region Page files

        static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8", [".mjs"] = "text/javascript; charset=utf-8",
            [".css"] = "text/css; charset=utf-8", [".json"] = "application/json; charset=utf-8", [".png"] = "image/png", [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg", [".svg"] = "image/svg+xml", [".woff2"] = "font/woff2", [".woff"] = "font/woff", [".mid"] = "audio/midi",
            [".wasm"] = "application/wasm", [".txt"] = "text/plain; charset=utf-8", [".md"] = "text/plain; charset=utf-8",
        };

        static string TypeOf(string path) => Types.TryGetValue(Path.GetExtension(path) ?? "", out var type) ? type : "application/octet-stream";

        /// <summary>
        /// A file of the page on screen (host is its label) or of the hidden preview (preview true):
        /// the bytes and their type, or null. The protected files always come from the app itself.
        /// </summary>
        public async Task<Tuple<byte[], string>> Serve(string host, string path, bool preview)
        {
            if (path.Length == 0) path = "piano.html";
            if (path.StartsWith("_desk/", StringComparison.Ordinal))
                return !preview && host == PageHost ? await desk.ServedFile(path) : null;
            var isProtected = path == "AGENTS.md" || path.StartsWith("assets/notation/", StringComparison.Ordinal) || path.StartsWith("assets/bravura/", StringComparison.Ordinal);
            var folder = isProtected ? source : preview ? Workspace : ActiveRoot;
            var ours = host == (preview ? "app" : PageHost);
            var file = ours ? Inside(folder, path) : null;
            if (file == null || !File.Exists(file)) return null;
            try { return Tuple.Create(File.ReadAllBytes(file), TypeOf(file)); }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { return null; }
        }

        #endregion

        #region core.js

        void ToCore(Dictionary<string, object> message)
        {
            if (!coreReady) { coreQueue.Add(message); return; }
            OnCore?.Invoke(message);
        }

        void ToCoreIfReady(Dictionary<string, object> message) { if (coreReady) OnCore?.Invoke(message); }

        /// <summary>
        /// A request for core.js: lesson-list, lesson-load, lesson-delete, page-error, page-loading,
        /// desk-*, lesson-progress, language, restore-original. Waits until core.js has started.
        /// Fails with a NativeError carrying core.js's error code.
        /// </summary>
        public Task<object> Ask(string command, Dictionary<string, object> body = null)
        {
            var identifier = ++nextQuestion;
            var answer = new TaskCompletionSource<object>();
            answers[identifier] = answer;
            ToCore(new Dictionary<string, object> { ["request"] = identifier, ["command"] = command, ["body"] = body ?? new Dictionary<string, object>() });
            return answer.Task;
        }

        /// <summary>Asks core.js without waiting for, or caring about, the answer.</summary>
        public void Tell(string command, Dictionary<string, object> body = null) =>
            Ask(command, body).ContinueWith(task => { _ = task.Exception; }, TaskScheduler.Default);

        /// <summary>The panel's web view started over; core.js starts over in it.</summary>
        public void CoreRestarted()
        {
            coreReady = false;
            // Whatever core.js was doing is gone with it, Codex's conversation too.
            StopCodex(notify: false);
            var pending = answers.Values.ToList();
            answers.Clear();
            foreach (var answer in pending) answer.TrySetException(new NativeError("restarted"));
        }

        Dictionary<string, object> AuthState()
        {
            Dictionary<string, object> account = null;
            if (SignedIn)
            {
                var claims = Claims(session.Text("id_token")) ?? new Dictionary<string, object>();
                account = new Dictionary<string, object> { ["email"] = claims.Text("email") ?? "", ["name"] = claims.Text("name") ?? "" };
            }
            return new Dictionary<string, object> { ["signedIn"] = account != null, ["account"] = account, ["signingIn"] = signingIn, ["signInError"] = signInError };
        }

        void PublishAuth() { if (coreReady) OnCore?.Invoke(new Dictionary<string, object> { ["auth"] = AuthState() }); }

        static string Text(Dictionary<string, object> body, string key) => body.Text(key) ?? "";

        /// <summary>One request of core.js ({op, …}); the result, or a NativeError.</summary>
        public async Task<object> Native(Dictionary<string, object> body)
        {
            var op = body.Text("op");
            switch (op)
            {
                case "info":
                    return new Dictionary<string, object>
                    {
                        ["platform"] = "windows", ["version"] = version, ["language"] = Localization.Language, ["available"] = Available, ["workspace"] = Workspace,
                    };
                case "preferences":
                    return new Dictionary<string, object> { ["welcomed"] = preferences.Flag("welcomed", false), ["open"] = preferences.Flag("open", false) };
                case "set-preference":
                {
                    var key = body.Text("key");
                    if (key != "welcomed" && key != "open") throw new NativeError("invalid");
                    preferences[key] = body.Flag("value", false); Save(preferences, "preferences.json");
                    return new Dictionary<string, object>();
                }
                case "auth":
                    return AuthState();
                case "read":
                {
                    var path = Location(body, write: false);
                    try { return path != null && File.Exists(path) ? Files.Read(path) : null; }
                    catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { return null; }
                }
                case "write":
                {
                    var path = Location(body, write: true);
                    var text = body.Text("text");
                    if (path == null || text == null) return false;
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(path));
                        if (body.Flag("exclusive", false))
                            using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
                            {
                                var bytes = new UTF8Encoding(false).GetBytes(text);
                                file.Write(bytes, 0, bytes.Length);
                            }
                        else Files.WriteAtomic(path, text);
                        return true;
                    }
                    catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { return false; }
                }
                case "list":
                {
                    var path = Location(body, write: false);
                    return path != null ? RelativeFiles(path).Cast<object>().ToList() : new List<object>();
                }
                case "exists":
                {
                    var path = Location(body, write: false);
                    return path == null ? null : Directory.Exists(path) ? "folder" : File.Exists(path) ? "file" : null;
                }
                case "same":
                {
                    byte[] Bytes(string path)
                    {
                        try { return path != null && File.Exists(path) ? File.ReadAllBytes(path) : null; }
                        catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { return null; }
                    }
                    var before = Bytes(Location(body.TryGetValue("a", out var a) ? a : null, write: false));
                    var after = Bytes(Location(body.TryGetValue("b", out var b) ? b : null, write: false));
                    return before == null ? after == null : after != null && before.SequenceEqual(after);
                }
                case "remove":
                case "trash":
                {
                    var path = Location(body, write: true);
                    if (path != null && !SamePath(path, root) && !SamePath(path, LessonsFolder))
                    {
                        if (op == "trash") Trash(path); else Files.Delete(path);
                    }
                    return new Dictionary<string, object>();
                }
                case "copy":
                    return CopyFrom(Location(body.TryGetValue("from", out var copyFrom) ? copyFrom : null, write: false),
                                    Location(body.TryGetValue("to", out var copyTo) ? copyTo : null, write: true));
                case "move":
                    return Move(Location(body.TryGetValue("from", out var moveFrom) ? moveFrom : null, write: true),
                                Location(body.TryGetValue("to", out var moveTo) ? moveTo : null, write: true));
                case "open-workspace":
                    // The box may change only the scratch copy (and Codex's home): it is made and opened to it here.
                    try { OpenBox(); return true; }
                    catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is InvalidOperationException ||
                                                  error is SystemException) { return false; }
                case "summaries":
                {
                    var path = Location(body, write: false);
                    return path != null ? Summaries(path) : new List<object>();
                }
                case "codex-ensure":
                    return await EnsureCodex();
                case "codex-write":
                    if (body.Text("line") is string line) WriteLine(line);
                    return new Dictionary<string, object>();
                case "sign-in":
                    _ = SignIn();
                    return new Dictionary<string, object>();
                case "cancel-sign-in":
                    CancelSignIn(); return new Dictionary<string, object>();
                case "sign-out":
                    SignOut(); return new Dictionary<string, object>();
                case "open-usage":
                    OpenInBrowser(UsageUrl); return new Dictionary<string, object>();
                case "preview":
                    if (Preview == null) return new Dictionary<string, object> { ["timedOut"] = true, ["errors"] = new List<object>() };
                    return await Preview(body.Text("script"));
                case "desk-entries":
                    return desk.Entries();
                case "desk-add":
                    if (body.TryGetValue("entry", out var entry) && entry is Dictionary<string, object> added) desk.AddEntry(added);
                    return new Dictionary<string, object>();
                case "desk-clear":
                    desk.Clear(); return new Dictionary<string, object>();
                case "desk-card":
                    return desk.Card(body.Text("card"));
                case "desk-update":
                    if (body.TryGetValue("card", out var card) && card is Dictionary<string, object> updated) desk.Update(updated);
                    return new Dictionary<string, object>();
                case "desk-show":
                    try { return new Dictionary<string, object> { ["card"] = await desk.Show(Text(body, "source"), Text(body, "title"), Text(body, "note")) }; }
                    catch (Exception error) { return new Dictionary<string, object> { ["error"] = error.Message ?? "" }; }
                case "desk-event":
                    if (body.TryGetValue("event", out var happened) && happened is Dictionary<string, object> deskEvent) OnDeskEvent?.Invoke(deskEvent);
                    return new Dictionary<string, object>();
                case "missing-tools":
                    return MissingTools?.Invoke(Text(body, "kind")) ?? 0;
                case "import-lesson":
                    if (ImportLesson == null) return new Dictionary<string, object> { ["error"] = Localization.Text("Ders başlatılamadı.") };
                    return ImportLesson(new Dictionary<string, object>
                    {
                        ["kind"] = Text(body, "kind"), ["file"] = desk.FileOf(body.Text("card")), ["link"] = body.Text("link"), ["title"] = Text(body, "title"),
                    });
                case "open-lesson":
                    if (body.TryGetValue("lesson", out var lesson) && lesson is Dictionary<string, object> changed) OnLessonChanged?.Invoke(changed);
                    return new Dictionary<string, object>();
                case "panel":
                {
                    var toggle = body.TryGetValue("toggle", out var width) && width != null && !(width is string) && !(width is bool)
                        ? Convert.ToDouble(width, System.Globalization.CultureInfo.InvariantCulture) : 0;
                    OnPanel?.Invoke(body.Flag("open", false), toggle);
                    return new Dictionary<string, object>();
                }
                case "show":
                {
                    var host = body.Text("host");
                    var design = body.Text("design");
                    // A host label: letters, digits and "-" only.
                    if (string.IsNullOrEmpty(host) || host.Length > 63 || host.ToLowerInvariant().Any(c => !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) ||
                        design == null || Inside(root, "designs/" + design) == null) throw new NativeError("invalid");
                    PageHost = host.ToLowerInvariant(); activeDesign = design;
                    OnShow?.Invoke(body.Flag("start", false));
                    if (!coreReady)
                    {
                        coreReady = true;
                        var queued = coreQueue.ToList(); coreQueue.Clear();
                        foreach (var message in queued) OnCore?.Invoke(message);
                    }
                    return new Dictionary<string, object>();
                }
                case "answer":
                {
                    var identifier = body.Number("id");
                    if (answers.TryGetValue(identifier, out var answer))
                    {
                        answers.Remove(identifier);
                        if (body.Text("error") is string error) answer.TrySetException(new NativeError(error));
                        else answer.TrySetResult(body.TryGetValue("value", out var value) ? value : null);
                    }
                    return new Dictionary<string, object>();
                }
                default:
                    throw new NativeError("invalid");
            }
        }

        public Dictionary<string, object> DeskCard(string card) => desk.Card(card);

        static void OpenInBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose(); }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException) { }
        }

        #endregion

        #region Sign in with ChatGPT

        static string Base64Url(byte[] data) => Convert.ToBase64String(data).Replace('+', '-').Replace('/', '_').TrimEnd('=');

        static string RandomToken(int bytes)
        {
            var data = new byte[bytes];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(data);
            return Base64Url(data);
        }

        static Dictionary<string, object> Claims(string jwt)
        {
            var parts = (jwt ?? "").Split('.');
            if (parts.Length < 2) return null;
            var body = parts[1].Replace('-', '+').Replace('_', '/');
            while (body.Length % 4 != 0) body += "=";
            try { return Json.Object(Encoding.UTF8.GetString(Convert.FromBase64String(body))); }
            catch (Exception) { return null; }
        }

        bool SignedIn => session.Text("refresh_token") != null;

        string HostIdentifier
        {
            get
            {
                var host = preferences.Text("host");
                if (host == null)
                {
                    host = "urn:uuid:" + Guid.NewGuid().ToString("D");
                    preferences["host"] = host; Save(preferences, "preferences.json");
                }
                return host;
            }
        }

        static Dictionary<string, string> Query(string query)
        {
            var values = new Dictionary<string, string>();
            foreach (var pair in (query ?? "").TrimStart('?').Split(new[] { '&' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var equals = pair.IndexOf('=');
                var name = Uri.UnescapeDataString((equals < 0 ? pair : pair.Substring(0, equals)).Replace('+', ' '));
                var value = equals < 0 ? "" : Uri.UnescapeDataString(pair.Substring(equals + 1).Replace('+', ' '));
                values[name] = value;
            }
            return values;
        }

        /// <summary>
        /// Opens ChatGPT's sign-in page in the browser and waits for it to come back to a one-time
        /// listener on this computer. The outcome reaches core.js as the sign-in state.
        /// </summary>
        async Task SignIn()
        {
            if (signingIn) return;
            TcpListener socket = null;
            var port = 1455;
            for (; port < 1466; port++)
            {
                try
                {
                    socket = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };
                    socket.Start(4);
                    break;
                }
                catch (SocketException) { socket = null; }
            }
            if (socket == null) { signInError = "port"; PublishAuth(); return; }
            var verifier = RandomToken(32);
            var state = RandomToken(16);
            var nonce = RandomToken(16);
            string challenge;
            using (var sha = SHA256.Create()) challenge = Base64Url(sha.ComputeHash(Encoding.ASCII.GetBytes(verifier)));
            var redirect = $"http://127.0.0.1:{port}/auth/callback";
            var client = preferences.Text("client") ?? "dynamic_agent_client";
            var query = new Dictionary<string, string>
            {
                ["response_type"] = "code", ["client_id"] = client, ["agent_name_hint"] = "rach3", ["ext_agent_host_id"] = HostIdentifier,
                ["redirect_uri"] = redirect, ["scope"] = Scope, ["resource"] = Resource, ["state"] = state, ["nonce"] = nonce,
                ["code_challenge"] = challenge, ["code_challenge_method"] = "S256",
            };
            var url = AuthorizeUrl + "?" + string.Join("&", query.Select(pair => pair.Key + "=" + Uri.EscapeDataString(pair.Value)));
            listener = socket; signingIn = true; signInError = null;
            PublishAuth();
            var waiting = Task.Run(() => Callback(socket));
            OpenInBrowser(url);
            var callback = await waiting;
            if (listener == socket) listener = null;
            if (callback == null) { signingIn = false; PublishAuth(); return; }
            if (callback.ContainsKey("error") || !callback.TryGetValue("state", out var returned) || returned != state || !callback.ContainsKey("code"))
            {
                signingIn = false;
                signInError = callback.TryGetValue("error", out var reason) && reason == "access_denied" ? "denied" : "failed";
                PublishAuth(); return;
            }
            var issued = callback.TryGetValue("client_id", out var given) && given.Length > 0 ? given : client;
            var exchange = await Token(new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code", ["client_id"] = issued, ["code"] = callback["code"], ["code_verifier"] = verifier,
                ["redirect_uri"] = redirect, ["resource"] = Resource,
            });
            signingIn = false;
            var error = exchange.Item2;
            var tokens = exchange.Item1;
            var claims = Claims(tokens?.Text("id_token"));
            if (error == null && (claims?.Text("nonce") != nonce || claims?.Text("iss") != "https://auth.openai.com")) error = "failed";
            if (error == null && !(tokens.Text("scope") ?? "").Split(' ').Contains(PlanScope)) error = "plan";
            if (error != null) { signInError = error; PublishAuth(); return; }
            preferences["client"] = issued; Save(preferences, "preferences.json");
            StoreTokens(tokens);
            OnSignedIn?.Invoke();
            PublishAuth();
        }

        /// <summary>Waits on a background thread for the browser to return to the listener.</summary>
        static Dictionary<string, string> Callback(TcpListener socket)
        {
            try
            {
                while (true)
                {
                    using (var connection = socket.AcceptTcpClient())
                    {
                        connection.ReceiveTimeout = 5000; connection.SendTimeout = 5000;
                        var stream = connection.GetStream();
                        var buffer = new byte[8192];
                        int length;
                        try { length = stream.Read(buffer, 0, buffer.Length); } catch (IOException) { continue; }
                        var head = Encoding.UTF8.GetString(buffer, 0, Math.Max(0, length));
                        var words = head.Split(new[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
                        Uri target = null;
                        if (words.Length > 1) Uri.TryCreate("http://127.0.0.1" + words[1], UriKind.Absolute, out target);
                        var ours = target != null && target.AbsolutePath == "/auth/callback";
                        var page = ours ? "<!doctype html><meta charset=utf-8><title>rach3</title><body style=\"font:16px system-ui,'Segoe UI',sans-serif;background:#131416;color:#eee;display:grid;place-items:center;height:90vh\"><p>rach3 ✓ — you can close this tab.</p>" : "";
                        var body = Encoding.UTF8.GetBytes(page);
                        var reply = Encoding.ASCII.GetBytes($"HTTP/1.1 {(ours ? "200 OK" : "404 Not Found")}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                        try { stream.Write(reply, 0, reply.Length); stream.Write(body, 0, body.Length); } catch (IOException) { }
                        if (ours) return Query(target.Query);
                    }
                }
            }
            catch (SocketException) { return null; }
            catch (ObjectDisposedException) { return null; }
            catch (InvalidOperationException) { return null; }
            finally { try { socket.Stop(); } catch (SocketException) { } }
        }

        void CancelSignIn()
        {
            var socket = listener;
            listener = null; signingIn = false;
            try { socket?.Stop(); } catch (SocketException) { }
            PublishAuth();
        }

        void StoreTokens(Dictionary<string, object> tokens)
        {
            var next = session.Copy();
            foreach (var key in new[] { "access_token", "refresh_token", "id_token", "scope" })
                if (tokens.TryGetValue(key, out var value) && value != null) next[key] = value;
            next["expires_at"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + tokens.Number("expires_in");
            session = next; Save(session, "session.json");
        }

        async Task<Tuple<Dictionary<string, object>, string>> Token(Dictionary<string, string> fields)
        {
            try
            {
                using (var content = new FormUrlEncodedContent(fields))
                using (var response = await http.PostAsync(TokenUrl, content))
                {
                    var text = await response.Content.ReadAsStringAsync();
                    Dictionary<string, object> body = null;
                    try { body = Json.Object(text); } catch (Exception) { }
                    if (response.StatusCode == HttpStatusCode.OK && body?.Text("access_token") != null) return Tuple.Create(body, (string)null);
                    var code = body?.Text("error") ?? "";
                    return Tuple.Create((Dictionary<string, object>)null, ExpiredCodes.Contains(code) ? "expired" : "failed");
                }
            }
            catch (HttpRequestException) { return Tuple.Create((Dictionary<string, object>)null, "offline"); }
            catch (TaskCanceledException) { return Tuple.Create((Dictionary<string, object>)null, "offline"); }
        }

        /// <summary>A token valid for at least ten more minutes; refreshes one at a time.</summary>
        async Task<Tuple<string, string>> FreshToken()
        {
            if (!SignedIn) return Tuple.Create((string)null, "signed-out");
            if (session.Number("expires_at") - DateTimeOffset.UtcNow.ToUnixTimeSeconds() > 600)
                return Tuple.Create(session.Text("access_token"), (string)null);
            if (refreshing == null) refreshing = Refresh();
            var running = refreshing;
            var error = await running;
            if (refreshing == running) refreshing = null;
            return Tuple.Create(error == null ? session.Text("access_token") : null, error);
        }

        async Task<string> Refresh()
        {
            var result = await Token(new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token", ["client_id"] = preferences.Text("client") ?? "",
                ["refresh_token"] = session.Text("refresh_token"), ["resource"] = Resource,
            });
            if (result.Item1 != null) StoreTokens(result.Item1);
            else if (result.Item2 == "expired") ForgetSession();
            return result.Item2;
        }

        void ForgetSession()
        {
            session = new Dictionary<string, object>();
            Files.Delete(Path.Combine(root, "session.json"));
            StopCodex(notify: true);
            PublishAuth();
        }

        void SignOut()
        {
            var refresh = session.Text("refresh_token");
            var client = preferences.Text("client");
            if (refresh != null && client != null)
            {
                var content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["token"] = refresh, ["token_type_hint"] = "refresh_token", ["client_id"] = client,
                });
                http.PostAsync(RevokeUrl, content).ContinueWith(task => { content.Dispose(); if (task.Status == TaskStatus.RanToCompletion) task.Result.Dispose(); });
            }
            ForgetSession();
        }

        #endregion

        #region Codex

        static string TomlString(string value) => "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        static void WriteCodexConfiguration(string home)
        {
            // CodexBox sets the limits: commands may read Windows itself and Codex's program,
            // and read and change the scratch copy and Codex's home, nothing else: not the
            // person's files, not rach3's other data, not the ChatGPT sign-in, which only
            // rach3's relay holds. Codex's own sandbox is off; it cannot run inside the box.
            // Codex itself may search the web (OpenAI runs the search); rach3 fetches anything it shows the person.
            var config = "# Written by rach3 on every start.\n" +
                "sandbox_mode = \"danger-full-access\"\n" +
                "web_search = \"live\"\n\n" +
                "[shell_environment_policy]\n" +
                "ignore_default_excludes = false\n" +
                "exclude = [\"ACCESS_TOKEN\", \"*TOKEN*\", \"*KEY*\", \"*SECRET*\"]\n";
            Files.WriteAtomic(Path.Combine(home, "config.toml"), config);
        }

        Dictionary<string, string> CodexEnvironment()
        {
            var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var key in new[] { "SystemRoot", "SystemDrive", "windir", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN",
                "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "COMPUTERNAME",
                "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "PATHEXT", "ComSpec",
                "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy" })
            {
                var value = Environment.GetEnvironmentVariable(key);
                if (!string.IsNullOrEmpty(value)) environment[key] = value;
            }
            var system = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
            environment["PATH"] = string.Join(";", Path.Combine(codexRoot, "codex-path"), Path.Combine(system, "System32"), system,
                Path.Combine(system, "System32", "Wbem"), Path.Combine(system, "System32", "WindowsPowerShell", "v1.0"));
            environment["CODEX_HOME"] = CodexHome;
            environment["TEMP"] = environment["TMP"] = Path.Combine(CodexHome, "tmp");   // the person's temporary folder is closed to the box
            return environment;
        }

        /// <summary>Opens Codex's program to the box for reading, and its home and the scratch copy for changing.</summary>
        void OpenBox()
        {
            Directory.CreateDirectory(Path.Combine(CodexHome, "tmp"));
            Directory.CreateDirectory(Workspace);
            var box = CodexBox.Identity();
            CodexBox.Grant(box, codexRoot, write: false);
            CodexBox.Grant(box, CodexHome, write: true);
            CodexBox.Grant(box, Workspace, write: true);
        }

        /// <summary>Starts the bundled Codex inside the box, joined to <paramref name="group"/> before it runs.</summary>
        BoxedProcess StartBoxed(IEnumerable<string> arguments, string directory, ProcessGroup group, string token = null)
        {
            OpenBox();
            var environment = CodexEnvironment();
            if (token != null) environment["ACCESS_TOKEN"] = token;
            return CodexBox.Start(CodexBinary, Files.Arguments(arguments), directory, environment, group.Add);
        }

        // Codex's newer models send searches to a separate endpoint that ChatGPT sign-in
        // tokens may not use. The Responses API itself accepts its web search tool with
        // these tokens, so rach3 hands Codex its own bundled model list with that path on.
        string WriteModelCatalog()
        {
            try
            {
                string output;
                using (var group = new ProcessGroup(belowNormal: false))
                using (var process = StartBoxed(new[] { "debug", "models", "--bundled" }, CodexHome, group))
                {
                    process.Input.Dispose();
                    _ = Task.Run(() => process.Error.ReadToEnd());
                    output = process.Output.ReadToEnd();
                    if (!process.WaitForExit(30000)) { group.Terminate(); return null; }
                    if (process.ExitCode != 0) return null;
                }
                var catalog = Json.Object(output);
                var models = catalog != null && catalog.TryGetValue("models", out var list) ? Collections.AsList(list) : null;
                if (models == null || models.Count == 0) return null;
                foreach (var model in models.OfType<Dictionary<string, object>>()) model["use_responses_lite"] = false;
                var file = Path.Combine(CodexHome, "models.json");
                Files.WriteAtomic(file, Json.Write(catalog));
                return file;
            }
            catch (Exception error) when (error is IOException || error is System.ComponentModel.Win32Exception || error is InvalidOperationException ||
                                          error is ArgumentException || error is UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>Codex running with a sign-in valid for ten more minutes. fresh: a new Codex started, which core.js then introduces itself to.</summary>
        async Task<Dictionary<string, object>> EnsureCodex()
        {
            var fresh = await FreshToken();
            if (fresh.Item2 != null) return new Dictionary<string, object> { ["error"] = fresh.Item2 };
            if (codex != null && codexToken == fresh.Item1) return new Dictionary<string, object> { ["fresh"] = false };
            StopCodex(notify: false);   // Codex reads the token at start
            var failure = await StartCodex(fresh.Item1);
            return failure != null ? new Dictionary<string, object> { ["error"] = failure } : new Dictionary<string, object> { ["fresh"] = true };
        }

        /// <summary>Where the relay carries Codex's requests: OpenAI, or in development builds a stand-in for it.</summary>
        static string Upstream
        {
            get
            {
#if PIANO_CAPTURE
                var development = Environment.GetEnvironmentVariable("RACH3_CODEX_UPSTREAM");
                if (!string.IsNullOrEmpty(development)) return development;
#endif
                return Resource;
            }
        }

        async Task<string> StartCodex(string token)
        {
            if (!Available) return "missing";
            Directory.CreateDirectory(CodexHome);
            Directory.CreateDirectory(Workspace);
            WriteCodexConfiguration(CodexHome);
            var catalog = await Task.Run(() => WriteModelCatalog());
            relay?.Dispose();
            relay = new CodexRelay(Upstream, () => codexToken);   // Codex reaches OpenAI only through rach3, which adds the sign-in
            const string provider = "model_providers.chatgpt_plan";
            var arguments = new List<string>
            {
                "app-server", "--listen", "stdio://",
                "-c", "model_provider=\"chatgpt_plan\"",
                "-c", provider + ".name=\"ChatGPT plan\"",
                "-c", provider + ".base_url=" + TomlString(relay.BaseUrl),
                "-c", provider + ".env_key=\"ACCESS_TOKEN\"",
                "-c", provider + ".wire_api=\"responses\"",
                "-c", provider + ".requires_openai_auth=false",
                "-c", provider + ".supports_websockets=false",
            };
            if (catalog != null) arguments.AddRange(new[] { "-c", "model_catalog_json=" + TomlString(catalog) });
            Directory.CreateDirectory(logs);
            var log = new StreamWriter(Path.Combine(logs, "codex.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
            var group = new ProcessGroup(belowNormal: false);
            BoxedProcess process;
            try { process = StartBoxed(arguments, Workspace, group, "rach3-relay"); }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception || error is InvalidOperationException ||
                                          error is IOException || error is UnauthorizedAccessException || error is SystemException)
            {
                lock (log) log.WriteLine("Codex did not start in its box: " + error.Message);
                group.Terminate(); group.Dispose(); log.Dispose();
                relay?.Dispose(); relay = null;
                return "missing";
            }
            new Thread(() =>
            {
                try { string line; while ((line = process.Error.ReadLine()) != null) lock (log) log.WriteLine(line); }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            }) { IsBackground = true, Name = "Codex errors" }.Start();
            codex = process; codexGroup = group; codexInput = process.Input; codexToken = token;
            new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = process.Output.ReadLine()) != null)
                    {
                        var text = line;
                        ui.Post(_ => { if (codex == process) ToCoreIfReady(new Dictionary<string, object> { ["codex"] = "line", ["text"] = text }); }, null);
                    }
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                try { process.WaitForExit(); } catch (ObjectDisposedException) { }
                lock (log) log.Dispose();
                ui.Post(_ => CodexEnded(process), null);
            }) { IsBackground = true, Name = "Codex output" }.Start();
            return null;
        }

        /// <summary>notify: core.js is told Codex stopped. A restart for a new sign-in does not tell it; it learns from codex-ensure.</summary>
        void StopCodex(bool notify)
        {
            var running = codex;
            var group = codexGroup;
            codex = null; codexGroup = null; codexInput = null; codexToken = null;
            group?.Terminate(); group?.Dispose();
            relay?.Dispose(); relay = null;
            if (running != null && notify) ToCoreIfReady(new Dictionary<string, object> { ["codex"] = "exit" });
        }

        void CodexEnded(BoxedProcess process)
        {
            process.Dispose();
            if (process != codex) return;
            codexGroup?.Dispose();
            relay?.Dispose(); relay = null;
            codex = null; codexGroup = null; codexInput = null; codexToken = null;
            ToCoreIfReady(new Dictionary<string, object> { ["codex"] = "exit" });
        }

        /// <summary>Stops Codex and any sign-in; Codex also ends with rach3 through its job object.</summary>
        public void Stop()
        {
            var socket = listener;
            listener = null; signingIn = false;
            try { socket?.Stop(); } catch (SocketException) { }
            StopCodex(notify: false);
        }

        void WriteLine(string line)
        {
            if (codexInput == null) return;
            var bytes = Encoding.UTF8.GetBytes(line + "\n");
            try { codexInput.Write(bytes, 0, bytes.Length); codexInput.Flush(); }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }

        #endregion
    }
}
