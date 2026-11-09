#if PIANO_CAPTURE
using System;
using System.Collections.Generic;
using System.IO;
using Velopack;
using Velopack.Logging;
using Velopack.Sources;

namespace Rach3
{
    /// <summary>
    /// Development-only check of a real installed update, never in releases:
    /// --self-test-update FOLDER KEY RESULT checks FOLDER for a newer package, accepts it only
    /// with a feed signature from KEY (base64 Ed25519) listing every file, downloads it (as
    /// patches when available) and applies it on exit.
    /// </summary>
    static class UpdateSelfTest
    {
        public sealed class FileLog : IVelopackLogger
        {
            readonly string path;
            public FileLog(string path) { this.path = path; }
            public void Log(VelopackLogLevel level, string message, Exception exception) =>
                File.AppendAllText(path, "[" + level + "] " + message + (exception == null ? "" : " " + exception) + "\r\n");
        }

        public static int Run(string folder, string key, string resultPath)
        {
            var result = new Dictionary<string, object>();
            try
            {
                var manager = new UpdateManager(new SimpleFileSource(new DirectoryInfo(folder)));
                result["installed"] = manager.IsInstalled;
                result["current"] = manager.CurrentVersion?.ToString();
                var info = manager.CheckForUpdatesAsync().GetAwaiter().GetResult();
                result["available"] = info?.TargetFullRelease.Version.ToString();
                if (info != null)
                {
                    var target = info.TargetFullRelease;
                    result["deltas"] = info.DeltasToTarget.Length;
                    result["base"] = info.BaseRelease?.Version.ToString();
                    List<Dictionary<string, object>> signed = null;
                    try
                    {
                        signed = Updates.SignedAssets(Convert.FromBase64String(key), File.ReadAllBytes(Path.Combine(folder, "releases.win.json")),
                            File.ReadAllText(Path.Combine(folder, "releases.win.json.sig")));
                        Updates.RequireSigned(signed, info);
                    }
                    catch (InvalidOperationException error) { result["rejected"] = error.Message; }
                    if (!result.ContainsKey("rejected"))
                    {
                        manager.DownloadUpdatesAsync(info).GetAwaiter().GetResult();
                        result["applying"] = target.Version.ToString();
                        File.WriteAllText(resultPath, Json.Write(result));
                        manager.WaitExitThenApplyUpdates(target, true, false);
                        return 0;
                    }
                }
            }
            catch (Exception error) { result["error"] = error.ToString(); }
            File.WriteAllText(resultPath, Json.Write(result));
            return 0;
        }
    }
}
#endif
