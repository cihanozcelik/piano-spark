using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Rach3
{
    /// <summary>
    /// The Mac app's Turkish→English native strings (extracted from desktop/Localization.m
    /// into Resources/strings.json at build time) plus the Windows shell's own strings.
    /// </summary>
    static class Localization
    {
        static Settings settings;
        static Dictionary<string, string> english = new Dictionary<string, string>();
        static Dictionary<string, string> turkish = new Dictionary<string, string>();

        static readonly Dictionary<string, string> Windows = new Dictionary<string, string>
        {
            ["Bu bilgisayarda Bluetooth MIDI henüz hazır değil."] = "Bluetooth MIDI is not available on this PC yet.",
            ["Bilgisayarın Bluetooth erişimi kontrol ediliyor…"] = "Checking Bluetooth access…",
            ["Bilgisayarın Bluetooth’u kapalı."] = "Bluetooth is turned off on this PC.",
            ["Bu bilgisayarda Bluetooth LE desteği bulunamadı."] = "This PC has no Bluetooth LE support.",
            ["Bilgisayarın Bluetooth servisi hazır değil."] = "This PC’s Bluetooth service is not ready.",
            ["Windows bağlantının kapandığını doğrulamadı."] = "Windows has not confirmed the disconnection.",
            ["Bilgisayarın Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı."] = "Preparing Bluetooth. Your piano is not connected yet.",
            ["MIDI bağlantısı hazırlanıyor… Windows eşleştirme onayı sorarsa onayla."] = "Preparing MIDI… Confirm pairing if Windows asks.",
            ["Ders motoru bu bilgisayarda bulunamadı. Rach3’ü yeniden yükle."] = "The lesson engine is missing. Reinstall Rach3.",
            ["Güncelleme indirildi. Rach3 yeniden başlatılınca yüklenecek."] = "The update has been downloaded. It will be installed when Rach3 restarts.",
            ["Güncelleme yükleniyor; Rach3 yeniden açılacak…"] = "Installing the update. Rach3 will reopen…",
        };

        public static void Load(string resources, Settings store)
        {
            settings = store;
            var path = Path.Combine(resources, "strings.json");
            var pairs = File.Exists(path) ? Json.Object(Files.Read(path)) : new Dictionary<string, object>();
            foreach (var pair in pairs) if (pair.Value is string value) english[pair.Key] = value;
            foreach (var pair in Windows) english[pair.Key] = pair.Value;
            foreach (var pair in english) turkish[pair.Value] = pair.Key;
        }

        public static string Language
        {
            get
            {
                var saved = settings?.Get("Rach3Language");
                if (saved == "en" || saved == "tr") return saved;
                return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "tr" ? "tr" : "en";
            }
            set => settings.Set("Rach3Language", value);
        }

        public static string Text(string text)
        {
            if (text == null) return null;
            var useTurkish = Language == "tr";
            if ((useTurkish ? turkish : english).TryGetValue(text, out var translated)) return translated;
            // The worker emits a count after this app-owned progress prefix.
            var source = useTurkish ? "Preparing note sections: " : "Nota bölümleri hazırlanıyor: ";
            var target = useTurkish ? "Nota bölümleri hazırlanıyor: " : "Preparing note sections: ";
            return text.StartsWith(source, StringComparison.Ordinal) ? target + text.Substring(source.Length) : text;
        }

        public static Dictionary<string, object> Status(Dictionary<string, object> status)
        {
            var localized = status.Copy();
            foreach (var key in new[] { "message", "detail", "error" })
                if (status.TryGetValue(key, out var value) && value is string text) localized[key] = Text(text);
            if (status.TryGetValue("diagnostic", out var diagnostic) && diagnostic is Dictionary<string, object> nested)
                localized["diagnostic"] = Status(nested);
            return localized;
        }
    }
}
