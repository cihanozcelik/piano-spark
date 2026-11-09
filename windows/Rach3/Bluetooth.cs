using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Rach3
{
    /// <summary>
    /// Piano connection state for the page: a port of the Bluetooth parts of desktop/main.m
    /// (startBluetooth, handleBluetooth, stopBluetooth). BleTransport plays the Mac helper's role.
    /// </summary>
    sealed class Bluetooth
    {
        readonly Settings settings;
        readonly SynchronizationContext ui = SynchronizationContext.Current;
        readonly Dictionary<string, object> state;
        readonly Dictionary<string, Dictionary<string, object>> held = new Dictionary<string, Dictionary<string, object>>();
        BleTransport transport;

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
            };
        }

        public bool Active => transport != null;

        public Dictionary<string, object> Status()
        {
            state["remembered_device"] = settings.Get("BluetoothDeviceUUID");
            return Localization.Status(state);
        }

        public object[] Held() => held.Values.Cast<object>().ToArray();

        void Publish(Dictionary<string, object> message) => OnEvent?.Invoke(message);

        void SetPhase(string phase, string message)
        {
            var connected = phase == "connected";
            state["phase"] = phase; state["connected"] = connected; state["message"] = message;
            if (!connected)
            {
                held.Clear(); state["pedal"] = null; state["output_capable"] = false; state["input_capable"] = false;
            }
            Publish(new Dictionary<string, object> { ["event"] = "status", ["status"] = state.Copy() });
        }

        public async Task<Dictionary<string, object>> Handle(string command, Dictionary<string, object> body)
        {
            if (command == "disconnect") { Stop(); return new Dictionary<string, object>(); }
            if (command == "connect" || command == "scan")
            {
                string identifier = null;
                if (command == "connect")
                {
                    identifier = BleTransport.Address(body.Text("uuid")) is ulong address ? BleTransport.Uuid(address) : null;
                    if (identifier == null) throw new UserError("Listeden bir MIDI cihazı seç.");
                }
                if (transport == null) { Start(identifier); return new Dictionary<string, object>(); }
                var phase = state.Text("phase");
                if (phase != "scanning" && phase != "idle") throw new UserError("Önce mevcut bağlantıyı kes.");
                var request = identifier != null
                    ? new Dictionary<string, object> { ["command"] = "connect", ["uuid"] = identifier }
                    : new Dictionary<string, object> { ["command"] = "scan" };
                return Checked(await transport.Command(request));
            }
            // output-start, output-stop, output-heartbeat
            if (!state.Flag("connected", false) || transport == null) throw new UserError("Piyano bağlı değil.");
            return Checked(await transport.Command(body));
        }

        static Dictionary<string, object> Checked(Dictionary<string, object> result)
        {
            var error = result.Text("error");
            if (error != null) throw new UserError(error);
            return result;
        }

        void Start(string identifier)
        {
            state["active"] = true;
            state.Remove("diagnostic");
            state["note_count"] = 0; state["last_note"] = null;
            state["uuid"] = identifier; state["device"] = ""; state["devices"] = new object[0];
            state["browsing"] = identifier == null;
            SetPhase("starting", "Bilgisayarın Bluetooth erişimi kontrol ediliyor…");
            BleTransport current = null;
            current = new BleTransport(ui,
                message => { if (transport == current) Handle(message); },
                code => ui.Post(_ => Exited(current, code), null));
            transport = current;
            current.Start(identifier == null ? null : BleTransport.Address(identifier));
        }

        void Exited(BleTransport finished, int code)
        {
            if (transport != finished) return;
            transport = null;
            state["active"] = false;
            if (state.Text("phase") == "error") SetPhase("error", state.Text("message"));
            else if (code != 0)
            {
                state["diagnostic"] = new Dictionary<string, object> { ["code"] = "service_failed", ["osCode"] = code };
                SetPhase("error", "Bluetooth bağlantı servisi kapandı.");
            }
            else SetPhase("disconnected", "Piyano bağlantısı kapalı");
            OnStopped?.Invoke();
        }

        public void Stop()
        {
            if (transport == null) return;
            SetPhase("stopping", "Bağlantı kapatılıyor…");
            transport.Stop("terminate", 0);
        }

        static string Key(Dictionary<string, object> message) =>
            (message.TryGetValue("channel", out var channel) ? channel : 1) + ":" + (message.TryGetValue("note", out var note) ? note : null);

        void Handle(Dictionary<string, object> message)
        {
            var kind = message.Text("event");
            if (kind == "output_error") { Publish(message); return; }
            if (kind == "connection_issue" || (kind == "stopped" && message.ContainsKey("diagnostic")))
            {
                state["diagnostic"] = message["diagnostic"];
                SetPhase("error", "Bluetooth bağlantısı tamamlanamadı."); return;
            }
            if (kind == "error")
            {
                if (!state.ContainsKey("diagnostic"))
                    state["diagnostic"] = new Dictionary<string, object>
                    {
                        ["code"] = "service_failed", ["detail"] = message.Text("message") ?? "", ["stage"] = message.Text("operation") ?? "",
                        ["osCode"] = message.TryGetValue("code", out var code) ? code : null,
                    };
                SetPhase("error", message.Text("message") ?? "Bluetooth bağlantısında hata oluştu");
            }
            else if (kind == "stopped")
            {
                if (!message.Flag("own_connection_closed", false))
                {
                    state["diagnostic"] = new Dictionary<string, object> { ["code"] = "disconnect_unconfirmed" };
                    SetPhase("error", "Windows bağlantının kapandığını doğrulamadı.");
                }
            }
            else if (state.Text("phase") == "stopping") return;
            else if (kind == "ready")
            {
                state.Remove("diagnostic");
                state["output_capable"] = message.Flag("output_capable", false);
                state["uuid"] = message.Text("uuid");
                state["device"] = message.Text("name") ?? "Bluetooth MIDI";
                state["input_capable"] = message.Flag("input_capable", true);
                SetPhase("connected", "MIDI bağlantısı hazır");
            }
            else if (kind == "discovered")
            {
                var devices = Collections.AsList(state["devices"]).Cast<object>()
                    .Where(item => !(item is Dictionary<string, object> found && found.Text("uuid") == message.Text("uuid"))).ToList();
                devices.Add(message);
                state["devices"] = devices.ToArray();
                Publish(new Dictionary<string, object> { ["event"] = "status", ["status"] = state.Copy() });
            }
            else if (kind == "scan_complete") SetPhase("idle", "Tarama tamamlandı. Listeden bir piyano seç veya yeniden tara.");
            else if (kind == "connection_timeout") SetPhase("error", "Piyanoya ulaşılamadı. Piyanonun açık ve Bluetooth’un etkin olduğunu kontrol et.");
            else if (kind == "disconnected") SetPhase("disconnected", "Piyano bağlantısı kesildi");
            else if (kind == "scanning")
            {
                state["devices"] = new object[0];
                var browsing = message.Flag("browsing", false);
                state["browsing"] = browsing;
                SetPhase(browsing ? "scanning" : "connecting", browsing ? "Yakındaki Bluetooth MIDI cihazları aranıyor…" : "Seçilen piyano aranıyor…");
            }
            else if (kind == "bluetooth_waiting") SetPhase("starting", "Bilgisayarın Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.");
            else if (kind == "midi_discovery") SetPhase("connecting", "Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…");
            else if (kind == "connecting")
            {
                state["uuid"] = message.Text("uuid"); state["device"] = message.Text("name");
                state["browsing"] = false;
                SetPhase("connecting", "Seçilen piyanoya bağlanılıyor…");
            }
            else if (kind == "midi_initial_read") SetPhase("connecting", "MIDI bağlantısı hazırlanıyor… Windows eşleştirme onayı sorarsa onayla.");
            else if (state.Flag("connected", false))
            {
                var key = Key(message);
                if (kind == "note_on" && message.Number("velocity") > 0)
                {
                    held[key] = message;
                    state["note_count"] = state.Number("note_count") + 1;
                    state["last_note"] = message;
                    Publish(message);
                }
                else if (kind == "note_off" || kind == "note_on")
                {
                    held.Remove(key); Publish(message);
                }
                else if (kind == "pedal")
                {
                    if (message.Text("pedal") == "sustain") state["pedal"] = message;
                    Publish(message);
                }
                else if (kind == "control_change" && (message.Number("controller") == 120 || message.Number("controller") == 123))
                {
                    foreach (var heldKey in held.Keys.ToList())
                    {
                        var note = held[heldKey];
                        if (!Equals(note.TryGetValue("channel", out var a) ? a : null, message.TryGetValue("channel", out var b) ? b : null)) continue;
                        var release = note.Copy();
                        release["event"] = "note_off"; release["velocity"] = 0;
                        held.Remove(heldKey); Publish(release);
                    }
                }
            }
        }
    }
}
