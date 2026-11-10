using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace Rach3
{
    /// <summary>An error the page shows to the user; the message is localized.</summary>
    sealed class UserError : Exception
    {
        public UserError(string message) : base(Localization.Text(message)) { }
    }

    /// <summary>JSON as plain dictionaries and arrays, like NSJSONSerialization on the Mac.</summary>
    static class Json
    {
        static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 512 };

        public static object Parse(string text) => Serializer.DeserializeObject(text);
        public static Dictionary<string, object> Object(string text) => Parse(text) as Dictionary<string, object>;
        public static string Write(object value) => Serializer.Serialize(value);

        public static string Text(this Dictionary<string, object> map, string key) =>
            map != null && map.TryGetValue(key, out var value) ? value as string : null;

        public static bool Flag(this Dictionary<string, object> map, string key, bool fallback) =>
            map != null && map.TryGetValue(key, out var value) && value is bool flag ? flag : fallback;

        public static long Number(this Dictionary<string, object> map, string key) =>
            map != null && map.TryGetValue(key, out var value) && value != null && !(value is string) && !(value is bool) &&
            value is IConvertible number ? Convert.ToInt64(number, CultureInfo.InvariantCulture) : 0;
    }

    /// <summary>Per-user data, like ~/Library/Application Support/Rach3 on the Mac.</summary>
    sealed class Paths
    {
        public string App, Resources, Engine, Support, Tools, WebData, Settings, Logs;

        public static Paths Create(string supportOverride)
        {
            var app = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            var support = supportOverride ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rach3");
            return new Paths
            {
                App = app,
                Resources = Path.Combine(app, "Resources"),
                Engine = Path.Combine(app, "Engine"),
                Support = support,
                // Short on purpose: Windows keeps the tool cache below MAX_PATH.
                Tools = Path.Combine(support, "Tools", "1"),
                WebData = Path.Combine(support, "WebView"),
                Settings = Path.Combine(support, "settings.json"),
                Logs = Path.Combine(support, "Logs"),
            };
        }
    }

    /// <summary>Small persistent preferences (NSUserDefaults on the Mac).</summary>
    sealed class Settings
    {
        readonly string path;
        readonly Dictionary<string, object> values;

        public Settings(string path)
        {
            this.path = path;
            try { values = Json.Object(File.ReadAllText(path, Encoding.UTF8)); } catch (Exception) { }
            values = values ?? new Dictionary<string, object>();
        }

        public string Get(string key) => values.Text(key);
        public object Value(string key) => values.TryGetValue(key, out var value) ? value : null;

        public void Set(string key, object value)
        {
            if (value == null) values.Remove(key); else values[key] = value;
            Files.WriteAtomic(path, Json.Write(values));
        }
    }

    static class Files
    {
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        public static void WriteAtomic(string path, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var pending = path + ".pending";
            File.WriteAllText(pending, text, Utf8);
            if (File.Exists(path)) File.Replace(pending, path, null);
            else File.Move(pending, path);
        }

        public static string Read(string path) => File.ReadAllText(path, Encoding.UTF8);

        public static void Delete(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
                else if (File.Exists(path)) File.Delete(path);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        /// <summary>One command-line argument with the MSVC C runtime quoting rules.</summary>
        public static string Quote(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
            var result = new StringBuilder("\"");
            for (var i = 0; i < argument.Length; i++)
            {
                var slashes = 0;
                while (i < argument.Length && argument[i] == '\\') { slashes++; i++; }
                if (i == argument.Length) { result.Append('\\', slashes * 2); break; }
                if (argument[i] == '"') result.Append('\\', slashes * 2 + 1).Append('"');
                else result.Append('\\', slashes).Append(argument[i]);
            }
            return result.Append('"').ToString();
        }

        public static string Arguments(IEnumerable<string> arguments) => string.Join(" ", arguments.Select(Quote));
    }

    /// <summary>A kill-on-close job object: a lesson worker and everything it starts end together.</summary>
    sealed class ProcessGroup : IDisposable
    {
        IntPtr handle;

        public ProcessGroup(bool belowNormal = true)
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // Kill on close, and below-normal priority for ffmpeg and the PDF reader too.
            info.BasicLimitInformation.LimitFlags = 0x2000 | (belowNormal ? 0x20u : 0);
            if (belowNormal) info.BasicLimitInformation.PriorityClass = 0x4000;
            var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(handle, 9, ref info, (uint)size))
                throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
        }

        public void Add(System.Diagnostics.Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle))
                throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
        }

        public void Add(IntPtr process)
        {
            if (!AssignProcessToJobObject(handle, process))
                throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
        }

        public void Terminate() { if (handle != IntPtr.Zero) TerminateJobObject(handle, 1); }

        public void Dispose()
        {
            if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
                ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);
    }

    static class Collections
    {
        public static Dictionary<string, object> Copy(this Dictionary<string, object> map) =>
            new Dictionary<string, object>(map);

        public static IList AsList(object value) => value as IList ?? new object[0];
    }
}
