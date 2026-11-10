using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Rach3
{
    /// <summary>A program rach3 started inside the Codex box, with its own pipes.</summary>
    sealed class BoxedProcess : IDisposable
    {
        public int Id { get; internal set; }
        public Stream Input { get; internal set; }
        public StreamReader Output { get; internal set; }
        public StreamReader Error { get; internal set; }
        internal SafeWaitHandle Handle;

        public bool WaitForExit(int milliseconds = -1) => CodexBox.WaitForSingleObject(Handle, milliseconds) == 0;

        public int ExitCode => CodexBox.GetExitCodeProcess(Handle, out var code) ? (int)code : -1;

        public void Dispose()
        {
            try { Input?.Dispose(); } catch (IOException) { }
            Output?.Dispose(); Error?.Dispose();
            Handle?.Dispose();
        }
    }

    /// <summary>
    /// rach3 starts Codex inside this box, the Windows counterpart of the Mac app's codex.sb.
    /// Windows, not Codex, enforces it, so it binds Codex itself and anything Codex starts.
    /// Codex runs with a restricted copy of the person's sign-in: a file opens only when it is
    /// open to the person and also to everyone, to all users, or to the box. Windows' own files
    /// are open to all users; the box is given Codex's program to read, and Codex's home and
    /// scratch folder to change. The person's files, which only they may open, rach3's other
    /// data (the ChatGPT sign-in among them) and other programs' data stay closed.
    /// (An AppContainer would be stricter, but Codex cannot start in one: Windows refuses
    /// to turn a path into its drive-letter form there, and Codex does that first.)
    /// </summary>
    static class CodexBox
    {
        /// <summary>
        /// The box's own identity, the same on every machine. It belongs to no account; it only
        /// names the box in folder permissions. (Windows takes no capability identity here.)
        /// </summary>
        public static SecurityIdentifier Identity() => new SecurityIdentifier("S-1-5-21-2604174936-1806624826-2876335745-1987");

        /// <summary>Development diagnosis only: more groups a file may be open to.</summary>
        internal static List<SecurityIdentifier> Extra = new List<SecurityIdentifier>();

        /// <summary>Lets the box read (and run) one folder, or read and change it.</summary>
        public static void Grant(SecurityIdentifier identity, string folder, bool write)
        {
            var security = Directory.GetAccessControl(folder);
            var rights = write ? FileSystemRights.Modify | FileSystemRights.Synchronize : FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
            security.AddAccessRule(new FileSystemAccessRule(identity, rights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(folder, security);
        }

        /// <summary>
        /// Starts a program inside the box with its own input, output and error pipes, held
        /// suspended until <paramref name="beforeRunning"/> has seen it (to join a job object).
        /// </summary>
        public static BoxedProcess Start(string program, string arguments, string directory, IDictionary<string, string> environment,
                                         Action<IntPtr> beforeRunning = null)
        {
            var identity = Identity();
            IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, attributes = IntPtr.Zero, handleList = IntPtr.Zero;
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
            var pinned = new List<GCHandle>();
            IntPtr Pin(object value) { var handle = GCHandle.Alloc(value, GCHandleType.Pinned); pinned.Add(handle); return handle.AddrOfPinnedObject(); }
            byte[] Binary(SecurityIdentifier sid) { var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0); return bytes; }
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), 0x000F01FF, out token)) throw Failed("OpenProcessToken");
                var user = WindowsIdentity.GetCurrent().User;
                // A file must be open to one of these as well as to the person.
                var allowed = new List<SecurityIdentifier>
                {
                    new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                    new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                    new SecurityIdentifier(WellKnownSidType.RestrictedCodeSid, null),
                    identity,
                };
                var logon = LogonSid(token);   // the window station and desktop of this session
                if (logon != null) allowed.Add(logon);
                allowed.AddRange(Extra);
                var restricting = allowed.Select(sid => new SID_AND_ATTRIBUTES { Sid = Pin(Binary(sid)) }).ToArray();
                if (!CreateRestrictedToken(token, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restricting.Length, restricting, out restricted))   // DISABLE_MAX_PRIVILEGE
                    throw Failed("CreateRestrictedToken");
                // What Codex itself creates (its pipes, its processes) is open to it and to the person.
                var dacl = new RawAcl(GenericAcl.AclRevision, 3);
                foreach (var sid in new[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), identity })
                    dacl.InsertAce(dacl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, sid, false, null));   // GENERIC_ALL
                var daclBytes = new byte[dacl.BinaryLength];
                dacl.GetBinaryForm(daclBytes, 0);
                var defaultDacl = new TOKEN_DEFAULT_DACL { DefaultDacl = Pin(daclBytes) };
                if (!SetTokenInformation(restricted, 6, ref defaultDacl, (uint)Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL))))   // TokenDefaultDacl
                    throw Failed("SetTokenInformation");

                var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
                if (!CreatePipe(out inputRead, out inputWrite, ref security, 0) || !CreatePipe(out outputRead, out outputWrite, ref security, 0) ||
                    !CreatePipe(out errorRead, out errorWrite, ref security, 0))
                    throw Failed("CreatePipe");
                foreach (var ours in new[] { inputWrite, outputRead, errorRead }) SetHandleInformation(ours, 1, 0);
                // Only the three pipe ends pass to the box, not every inheritable handle rach3 holds.
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, inputRead);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, outputWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errorWrite);
                var size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size) ||
                    !UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020002, handleList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw Failed("UpdateProcThreadAttribute");

                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = 0x100;   // STARTF_USESTDHANDLES
                startup.StartupInfo.hStdInput = inputRead; startup.StartupInfo.hStdOutput = outputWrite; startup.StartupInfo.hStdError = errorWrite;
                startup.lpAttributeList = attributes;
                var block = new StringBuilder();
                foreach (var pair in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
                block.Append('\0');
                var commandLine = new StringBuilder(Files.Arguments(new[] { program }) + (string.IsNullOrEmpty(arguments) ? "" : " " + arguments));
                const uint flags = 0x00080000 | 0x08000000 | 0x00000400 | 0x00000004;   // extended startup info, no window, Unicode environment, suspended
                if (!CreateProcessAsUser(restricted, program, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, block.ToString(), directory, ref startup, out var info))
                    throw Failed("CreateProcessAsUser");

                var process = new BoxedProcess { Id = info.dwProcessId, Handle = new SafeWaitHandle(info.hProcess, true) };
                try { beforeRunning?.Invoke(info.hProcess); }
                catch { TerminateProcess(process.Handle, 1); CloseHandle(info.hThread); process.Dispose(); throw; }
                ResumeThread(info.hThread);
                CloseHandle(info.hThread);
                var encoding = new UTF8Encoding(false);
                process.Input = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 4096);
                process.Output = new StreamReader(new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 4096), encoding);
                process.Error = new StreamReader(new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read, 4096), encoding);
                inputWrite = outputRead = errorRead = IntPtr.Zero;
                return process;
            }
            finally
            {
                foreach (var theirs in new[] { inputRead, outputWrite, errorWrite }) if (theirs != IntPtr.Zero) CloseHandle(theirs);
                foreach (var ours in new[] { inputWrite, outputRead, errorRead }) if (ours != IntPtr.Zero) CloseHandle(ours);
                if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (restricted != IntPtr.Zero) CloseHandle(restricted);
                if (token != IntPtr.Zero) CloseHandle(token);
                foreach (var handle in pinned) handle.Free();
            }
        }

        static Win32Exception Failed(string step)
        {
            var code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, step + ": " + new Win32Exception(code).Message);
        }

        static SecurityIdentifier LogonSid(IntPtr token)
        {
            GetTokenInformation(token, 28, IntPtr.Zero, 0, out var length);   // TokenLogonSid
            if (length == 0) return null;
            var buffer = Marshal.AllocHGlobal((int)length);
            try
            {
                if (!GetTokenInformation(token, 28, buffer, length, out length) || Marshal.ReadInt32(buffer) < 1) return null;
                return new SecurityIdentifier(Marshal.ReadIntPtr(buffer, IntPtr.Size));   // TOKEN_GROUPS: count, then the first SID_AND_ATTRIBUTES
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        #region Windows

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

        [StructLayout(LayoutKind.Sequential)]
        struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

        [StructLayout(LayoutKind.Sequential)]
        struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int type, IntPtr information, uint length, out uint returned);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete,
                                                 uint restrictCount, SID_AND_ATTRIBUTES[] restrict, out IntPtr restricted);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetTokenInformation(IntPtr token, int type, ref TOKEN_DEFAULT_DACL information, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        static extern void DeleteProcThreadAttributeList(IntPtr list);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
                                               bool inherit, uint flags, string environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);

        [DllImport("kernel32.dll")]
        static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        internal static extern uint WaitForSingleObject(SafeWaitHandle handle, int milliseconds);

        [DllImport("kernel32.dll")]
        internal static extern bool GetExitCodeProcess(SafeWaitHandle handle, out uint code);

        [DllImport("kernel32.dll")]
        static extern bool TerminateProcess(SafeWaitHandle handle, uint code);

        #endregion
    }
}
