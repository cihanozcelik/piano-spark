using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;

namespace PianoSpark
{
    /// <summary>
    /// Update state for the page's update panel (UpdateController.m on the Mac).
    /// Checking and installing are added with the Windows installer.
    /// </summary>
    sealed partial class Updates
    {
        readonly Dictionary<string, object> release;
        string status = "Güncellemeler otomatik denetlenir.";
        string availableVersion = "", availableNotes = "";
        bool newVersion;
        readonly Settings settings;

        public Action<Dictionary<string, object>> OnChange;

        public Updates(Paths paths, Settings settings, bool automatic)
        {
            this.settings = settings;
            release = Json.Object(Files.Read(Path.Combine(paths.Resources, "release.json")));
            var version = Version;
            newVersion = settings.Get("AnnouncedVersion") is string seen && seen != version;
            if (settings.Get("AnnouncedVersion") == null) settings.Set("AnnouncedVersion", version);
            Initialize(paths, automatic);
        }

        public string Version => release.Text("version");

        IList Notes()
        {
            if (release.TryGetValue("localizedNotes", out var localized) && localized is Dictionary<string, object> byLanguage &&
                byLanguage.TryGetValue(Localization.Language, out var notes) && notes is IList list) return list;
            return Collections.AsList(release.TryGetValue("notes", out var plain) ? plain : null);
        }

        public Dictionary<string, object> Snapshot() => new Dictionary<string, object>
        {
            ["event"] = "update", ["version"] = Version, ["notes"] = Notes(), ["newVersion"] = newVersion,
            ["message"] = Localization.Text(status), ["availableVersion"] = availableVersion, ["availableNotes"] = availableNotes,
        };

        void Changed() => OnChange?.Invoke(Snapshot());

        public void Acknowledge()
        {
            newVersion = false;
            settings.Set("AnnouncedVersion", Version);
            Changed();
        }

        partial void Initialize(Paths paths, bool automatic);
        partial void CheckNow();
        partial void Install();

        public void Check() => CheckNow();
        public void InstallOnExit() => Install();
    }
}
