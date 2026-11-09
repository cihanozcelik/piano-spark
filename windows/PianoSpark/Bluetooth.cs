using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace PianoSpark
{
    /// <summary>
    /// Piano connection state for the page (the Mac's Bluetooth helper state in main.m).
    /// The Windows BLE-MIDI transport plugs into Connect/Scan/Output.
    /// </summary>
    sealed partial class Bluetooth
    {
        readonly Settings settings;
        readonly Dictionary<string, object> state;
        readonly Dictionary<string, Dictionary<string, object>> held = new Dictionary<string, Dictionary<string, object>>();

        public Action<Dictionary<string, object>> OnEvent;
        public Action OnStopped;

        public Bluetooth(Settings settings)
        {
            this.settings = settings;
            state = new Dictionary<string, object>
            {
                ["phase"] = "disconnected", ["connected"] = false, ["message"] = "Piyano bağlı değil", ["device"] = "",
                ["uuid"] = null, ["devices"] = new object[0], ["input_capable"] = false, ["note_count"] = 0,
                ["last_note"] = null, ["pedal"] = null, ["active"] = false,
                ["remembered_device"] = settings.Get("BluetoothDeviceUUID"),
            };
        }

        public bool Active => state.Flag("active", false);
        public Dictionary<string, object> Status()
        {
            state["remembered_device"] = settings.Get("BluetoothDeviceUUID");
            return Localization.Status(state);
        }
        public object[] Held() => held.Values.Cast<object>().ToArray();

        public Task<Dictionary<string, object>> Handle(string command, Dictionary<string, object> body)
        {
            if (command == "disconnect") { Stop(); return Task.FromResult(new Dictionary<string, object>()); }
            if (command.StartsWith("output-", StringComparison.Ordinal) && !state.Flag("connected", false))
                throw new UserError("Piyano bağlı değil.");
            return Transport(command, body);
        }

        public void Stop() => StopTransport();

        partial void StopTransport();

        Task<Dictionary<string, object>> Transport(string command, Dictionary<string, object> body)
        {
            Task<Dictionary<string, object>> result = null;
            TransportCommand(command, body, ref result);
            if (result == null) throw new UserError("Bu bilgisayarda Bluetooth MIDI henüz hazır değil.");
            return result;
        }

        partial void TransportCommand(string command, Dictionary<string, object> body, ref Task<Dictionary<string, object>> result);
    }
}
