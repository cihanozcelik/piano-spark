using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
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
    /// against that signed feed. Every file Velopack may download, the full package and each
    /// patch, must be listed in the signed feed with the same SHA-256 that Velopack then checks
    /// the download against; patches apply to the installed, already verified package.
    /// (A package rebuilt from patches is re-zipped, so it is not byte-identical to the full
    /// package and is not compared with it.) Updates download in the background and install on quit.
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
                await manager.DownloadUpdatesAsync(info);
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

        /// <summary>
        /// Every file Velopack may download, the full package and each patch, must be in the signed
        /// feed. Velopack verifies each download against these same SHA-256 values.
        /// </summary>
        public static void RequireSigned(List<Dictionary<string, object>> signed, UpdateInfo info)
        {
            foreach (var asset in new[] { info.TargetFullRelease }.Concat(info.DeltasToTarget))
                if (string.IsNullOrEmpty(asset.SHA256) || !Lists(signed, asset.FileName, asset.SHA256, asset.Size))
                    throw new InvalidOperationException("The update file " + asset.FileName + " is not in the signed feed");
        }

        partial void Install()
        {
            if (manager == null || pending == null) return;
            try { manager.WaitExitThenApplyUpdates(pending.TargetFullRelease, true, false); }
            catch (Exception error) { Trace.WriteLine("Update install failed: " + error); }
        }
    }
}
