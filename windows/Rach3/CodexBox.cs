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
    /// <summary>
    /// rach3 starts Codex inside a Windows AppContainer, the Windows counterpart of the Mac
    /// app's codex.sb. Windows, not Codex, enforces it, so it binds Codex itself and anything
    /// Codex starts. The container may read Windows' own files and Codex's program, read and
    /// write Codex's home and the scratch folder, and reach the internet. The person's files,
    /// rach3's other data (the ChatGPT sign-in among them) and other programs' data are closed.
    /// </summary>
    sealed class BoxedProcess : IDisposable
    {
        public int Id { get; internal set; }
        public Stream Input { get; internal set; }
        public StreamReader Output { get; internal set; }
        public StreamReader Error { get; internal set; }
        internal SafeWaitHandle Handle;

        public bool WaitForExit(int milliseconds = -1) => CodexBox.WaitForSingleObject(Handle, milliseconds) == 0;

        public int ExitCode => CodexBox.GetExitCodeProcess(Handle, out var code) ? (int)code : -1;

        public void Kill() { try { CodexBox.TerminateProcess(Handle, 1); } catch (ObjectDisposedException) { } }

        public void Dispose()
        {
            try { Input?.Dispose(); } catch (IOException) { }
            Output?.Dispose(); Error?.Dispose();
            Handle?.Dispose();
        }
    }

    static class CodexBox
    {
        const string Name = "rach3.codex";
        const string InternetClient = "S-1-15-3-1";

        /// <summary>The container's identity; made once per Windows account, then reused.</summary>
        public static SecurityIdentifier Identity()
        {
            var result = CreateAppContainerProfile(Name, "rach3 Codex", "Codex as rach3 runs it", IntPtr.Zero, 0, out var sid);
            if (result == unchecked((int)0x800700B7)) result = DeriveAppContainerSidFromAppContainerName(Name, out sid);
            if (result != 0) throw new Win32Exception(result, "The Codex container could not be made");
            try { return new SecurityIdentifier(sid); }
            finally { FreeSid(sid); }
        }

        /// <summary>Lets the container read (and run) one folder, or read and write it.</summary>
        public static void Grant(SecurityIdentifier identity, string folder, bool write)
        {
            var security = Directory.GetAccessControl(folder);
            var rights = write ? FileSystemRights.Modify | FileSystemRights.Synchronize : FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
            security.AddAccessRule(new FileSystemAccessRule(identity, rights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(folder, security);
        }

        /// <summary>
        /// Starts a program inside the container with its own input, output and error pipes,
        /// held suspended until <paramref name="beforeRunning"/> has seen it (to join a job object).
        /// </summary>
        public static BoxedProcess Start(string program, string arguments, string directory, IDictionary<string, string> environment,
                                         Action<IntPtr> beforeRunning = null)
        {
            var identity = Identity();
            var sidBytes = new byte[identity.BinaryLength];
            identity.GetBinaryForm(sidBytes, 0);
            var internet = new SecurityIdentifier(InternetClient);
            var internetBytes = new byte[internet.BinaryLength];
            internet.GetBinaryForm(internetBytes, 0);

            var pinned = new List<GCHandle>();
            IntPtr Pin(object value) { var handle = GCHandle.Alloc(value, GCHandleType.Pinned); pinned.Add(handle); return handle.AddrOfPinnedObject(); }
            IntPtr attributes = IntPtr.Zero, capabilities = IntPtr.Zero, handleList = IntPtr.Zero;
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
            try
            {
                var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
                if (!CreatePipe(out inputRead, out inputWrite, ref security, 0) || !CreatePipe(out outputRead, out outputWrite, ref security, 0) ||
                    !CreatePipe(out errorRead, out errorWrite, ref security, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                foreach (var ours in new[] { inputWrite, outputRead, errorRead }) SetHandleInformation(ours, 1, 0);

                var granted = new SID_AND_ATTRIBUTES { Sid = Pin(internetBytes), Attributes = 4 };   // SE_GROUP_ENABLED
                capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
                Marshal.StructureToPtr(new SECURITY_CAPABILITIES
                {
                    AppContainerSid = Pin(sidBytes), Capabilities = Pin(new[] { granted }), CapabilityCount = 1,
                }, capabilities, false);
                // Only the three pipe ends pass to the container, not every inheritable handle rach3 holds.
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, inputRead);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, outputWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errorWrite);

                var size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020009, capabilities, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero) ||
                    !UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020002, handleList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());

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
                if (!CreateProcess(program, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, block.ToString(), directory, ref startup, out var info))
                    throw new Win32Exception(Marshal.GetLastWin32Error());

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
                if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                foreach (var handle in pinned) handle.Free();
            }
        }

#if PIANO_CAPTURE
        /// <summary>Development only: how a path resolves from inside the box, the way Codex resolves its home.</summary>
        public static int PathProbe(string path)
        {
            var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);   // any access, share all, open existing, backup semantics
            if (handle.IsInvalid) { Console.WriteLine("open error " + Marshal.GetLastWin32Error()); return 2; }
            using (handle)
            {
                foreach (var flag in new uint[] { 0, 2 })   // VOLUME_NAME_DOS, VOLUME_NAME_NT
                {
                    var buffer = new StringBuilder(1024);
                    var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, flag);
                    Console.WriteLine((flag == 0 ? "dos " : "nt ") + (length == 0 ? "error " + Marshal.GetLastWin32Error() : buffer.ToString()));
                }
            }
            return 0;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetFinalPathNameByHandleW")]
        static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
#endif

        #region Windows

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

        [StructLayout(LayoutKind.Sequential)]
        struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

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

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

        [DllImport("advapi32.dll")]
        static extern IntPtr FreeSid(IntPtr sid);

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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit,
                                         uint flags, string environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);

        [DllImport("kernel32.dll")]
        static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        internal static extern uint WaitForSingleObject(SafeWaitHandle handle, int milliseconds);

        [DllImport("kernel32.dll")]
        internal static extern bool GetExitCodeProcess(SafeWaitHandle handle, out uint code);

        [DllImport("kernel32.dll")]
        internal static extern bool TerminateProcess(SafeWaitHandle handle, uint code);

        #endregion
    }
}
