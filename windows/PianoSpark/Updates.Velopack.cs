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
    /// against that signed feed. Updates download in the background and install on quit.
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
                await VerifySigned(target);
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
        async Task VerifySigned(VelopackAsset target)
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
            CheckSignature(publicKey, feed, signature, target);
        }

        /// <summary>Throws unless the feed is signed by the key and lists exactly this package.</summary>
        public static void CheckSignature(byte[] key, byte[] feed, string signature, VelopackAsset target)
        {
            if (!Ed25519.Verify(key, feed, Convert.FromBase64String(signature.Trim())))
                throw new InvalidOperationException("The update feed signature is invalid");
            var assets = Collections.AsList(Json.Object(Encoding.UTF8.GetString(feed).TrimStart('\uFEFF'))?["Assets"]);
            var signed = assets.Cast<object>().OfType<Dictionary<string, object>>().Any(asset =>
                asset.Text("FileName") == target.FileName &&
                string.Equals(asset.Text("SHA256"), target.SHA256, StringComparison.OrdinalIgnoreCase));
            if (!signed) throw new InvalidOperationException("The update package is not in the signed feed");
        }

        partial void Install()
        {
            if (manager == null || pending == null) return;
            try { manager.WaitExitThenApplyUpdates(pending.TargetFullRelease, true, false); }
            catch (Exception error) { Trace.WriteLine("Update install failed: " + error); }
        }
    }
}
