using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace PianoSpark
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            // Velopack's install, update and uninstall hooks run here and exit.
            // Uninstalling removes lessons, tools and settings, like the Mac app's uninstaller.
            var velopack = Velopack.VelopackApp.Build()
                .OnBeforeUninstallFastCallback(version => Files.Delete(Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Piano Spark")));
#if PIANO_CAPTURE
            if (args.Length == 4 && args[0] == "--self-test-update") velopack = velopack.SetLogger(new UpdateSelfTest.FileLog(args[3] + ".log"));
#endif
            velopack.Run();
#if PIANO_CAPTURE
            if (args.Length == 4 && args[0] == "--self-test-update") return UpdateSelfTest.Run(args[1], args[2], args[3]);
#endif
            var options = Options.Parse(args);
            // One window per user, like a Mac app. A second launch brings the first forward.
            using (var single = new Mutex(true, @"Local\PianoSpark.Desktop", out var first))
            {
                if (!first && options.Capture == null)
                {
                    var window = FindWindow(null, "Rach3");
                    if (window != IntPtr.Zero) { ShowWindow(window, 9); SetForegroundWindow(window); }
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.Run(new MainForm(options));
                GC.KeepAlive(single);
                return 0;
            }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindow(string className, string title);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr window);
    }
}
