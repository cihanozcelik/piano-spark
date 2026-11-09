using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace PianoSpark
{
    /// <summary>
    /// Windows updates through Velopack and the project's GitHub releases. Like Sparkle on
    /// the Mac, an update is trusted only when its feed carries a valid Ed25519 signature
    /// from the release key in release.json; Velopack then checks the package's SHA-256
    /// against that signed feed. Every file, the full package and each patch, must be listed
    /// in the signed feed, and the package rebuilt from patches must match the signed full
    /// package before it is installed. Updates download in the background and install on quit.
    /// </summary>
    sealed partial class Updates
    {
        UpdateManager manager;
        UpdateInfo pending;
        bool checking;
        System.Windows.Forms.Timer timer;
        string repository;
        byte[] publicKey;

        partial void Initialize(Paths paths, bool automatic)
        {
            repository = release.Text("repository");
            publicKey = Convert.FromBase64String(release.Text("publicKey"));
            if (!automatic) return;
            try
            {
                manager = new UpdateManager(new GithubSource("https://github.com/" + repository, null, false));
                if (!manager.IsInstalled) manager = null;
            }
            catch (Exception error) { Trace.WriteLine("Updates unavailable: " + error); manager = null; }
            if (manager == null) return;
            timer = new System.Windows.Forms.Timer { Interval = 15 * 1000 };
            timer.Tick += (sender, args) => { timer.Interval = 6 * 60 * 60 * 1000; CheckNow(); };
            timer.Start();
        }

        partial void CheckNow() { _ = CheckAsync(); }

        async Task CheckAsync()
        {
            if (manager == null || checking || pending != null) { Changed(); return; }
            checking = true;
            status = "Yeni sürüm aranıyor…"; Changed();
            try
            {
                var info = await manager.CheckForUpdatesAsync();
                if (info == null) { status = "En güncel sürüm yüklü."; return; }
                var target = info.TargetFullRelease;
                var signed = await SignedFeed(target);
                RequireSigned(signed, info);
                availableVersion = target.Version.ToString();
                availableNotes = target.NotesMarkdown ?? "";
                status = "Yeni sürüm arka planda indiriliyor…"; Changed();
                await Download(manager, info, signed);
                pending = info;
                status = "Güncelleme indirildi. Piano Spark yeniden başlatılınca yüklenecek.";
            }
            catch (Exception error)
            {
                Trace.WriteLine("Update failed: " + error);
                status = "Güncelleme tamamlanamadı. İnternet bağlantısını kontrol et; mevcut sürümle devam edebilirsin.";
            }
            finally { checking = false; Changed(); }
        }

        /// <summary>The update's release must carry releases.win.json signed with the release key.</summary>
        async Task<List<Dictionary<string, object>>> SignedFeed(VelopackAsset target)
        {
            var folder = "https://github.com/" + repository + "/releases/download/v" + target.Version + "/";
            byte[] feed;
            string signature;
            using (var http = new HttpClient())
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd("PianoSpark/" + Version);
                feed = await http.GetByteArrayAsync(folder + "releases.win.json");
                signature = await http.GetStringAsync(folder + "releases.win.json.sig");
            }
            return SignedAssets(publicKey, feed, signature);
        }

        /// <summary>The packages listed in a feed, only when the feed carries a valid signature from the key.</summary>
        public static List<Dictionary<string, object>> SignedAssets(byte[] key, byte[] feed, string signature)
        {
            if (!Ed25519.Verify(key, feed, Convert.FromBase64String(signature.Trim())))
                throw new InvalidOperationException("The update feed signature is invalid");
            return Collections.AsList(Json.Object(Encoding.UTF8.GetString(feed).TrimStart('\uFEFF'))?["Assets"])
                .Cast<object>().OfType<Dictionary<string, object>>().ToList();
        }

        static bool Lists(List<Dictionary<string, object>> signed, string fileName, string sha256, long size) =>
            signed.Any(asset => asset.Text("FileName") == fileName && asset.Number("Size") == size &&
                string.Equals(asset.Text("SHA256"), sha256, StringComparison.OrdinalIgnoreCase));

        /// <summary>Every file Velopack will download, the full package and each patch, must be in the signed feed.</summary>
        public static void RequireSigned(List<Dictionary<string, object>> signed, UpdateInfo info)
        {
            foreach (var asset in new[] { info.TargetFullRelease }.Concat(info.DeltasToTarget))
                if (string.IsNullOrEmpty(asset.SHA256) || !Lists(signed, asset.FileName, asset.SHA256, asset.Size))
                    throw new InvalidOperationException("The update file " + asset.FileName + " is not in the signed feed");
        }

        /// <summary>
        /// Downloads the update, as patches when Velopack offers them. If the rebuilt package does
        /// not match the signed full package, it is deleted and the full package downloaded instead.
        /// Returns true when the patches were used.
        /// </summary>
        public static async Task<bool> Download(UpdateManager manager, UpdateInfo info, List<Dictionary<string, object>> signed)
        {
            await manager.DownloadUpdatesAsync(info);
            try { RequireDownloaded(signed, info.TargetFullRelease); return info.DeltasToTarget.Length > 0; }
            catch (InvalidOperationException) when (info.DeltasToTarget.Length > 0)
            {
                Trace.WriteLine("The package rebuilt from patches did not match; downloading the full package");
                await manager.DownloadUpdatesAsync(new UpdateInfo(info.TargetFullRelease, info.IsDowngrade));
                RequireDownloaded(signed, info.TargetFullRelease);
                return false;
            }
        }

        /// <summary>
        /// The package Velopack will install, whether downloaded whole or rebuilt from patches,
        /// must be byte for byte the full package in the signed feed. A mismatch is deleted.
        /// </summary>
        public static void RequireDownloaded(List<Dictionary<string, object>> signed, VelopackAsset target)
        {
            var root = Path.GetDirectoryName(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            var package = Path.Combine(root, "packages", target.FileName);
            string digest;
            long size;
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(package))
            {
                size = stream.Length;
                digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
            }
            if (!Lists(signed, target.FileName, digest, size))
            {
                Files.Delete(package);
                throw new InvalidOperationException("The downloaded update does not match the signed feed");
            }
        }

        partial void Install()
        {
            if (manager == null || pending == null) return;
            try { manager.WaitExitThenApplyUpdates(pending.TargetFullRelease, true, false); }
            catch (Exception error) { Trace.WriteLine("Update install failed: " + error); }
        }
    }
}
