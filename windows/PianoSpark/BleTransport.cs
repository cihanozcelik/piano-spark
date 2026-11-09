using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Security.Cryptography;

namespace PianoSpark
{
    /// <summary>
    /// The Windows BLE-MIDI connection: the counterpart of the Mac's Bluetooth helper
    /// (bluetooth-connection/main.m). It emits the same events, so the app-side state
    /// machine and the page diagnostics are shared. All state changes run on the UI thread.
    /// </summary>
    sealed class BleTransport
    {
        static readonly Guid ServiceUuid = new Guid("03B80E5A-EDE8-4B33-A751-6CE34EC4C700");
        static readonly Guid CharacteristicUuid = new Guid("7772E5DB-3868-4112-A1A9-F2669D106BF3");
        const double TimeoutSeconds = 45;

        readonly SynchronizationContext ui;
        readonly Action<Dictionary<string, object>> emit;
        readonly Action<int> exited;
        readonly BleMidiDecoder decoder = new BleMidiDecoder();
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Dictionary<ulong, string> names = new Dictionary<ulong, string>();
        readonly HashSet<ulong> midiDevices = new HashSet<ulong>();
        readonly Dictionary<ulong, double> lastAdvertisement = new Dictionary<ulong, double>();
        Radio radio;
        BluetoothLEAdvertisementWatcher watcher;
        BluetoothLEDevice device;
        GattDeviceService service;
        GattCharacteristic midi;
        BleMidiOutput output;
        System.Threading.Timer deadline;
        int generation;
        string phase = "starting", target = "", stopReason = "stopped";
        ulong? identifier;
        bool browsing, ready, stopping, finished, linkEstablished, deviceSeen;
        int exitCode;
        Dictionary<string, object> diagnostic;

        public BleTransport(SynchronizationContext ui, Action<Dictionary<string, object>> emit, Action<int> exited)
        {
            this.ui = ui; this.emit = emit; this.exited = exited;
        }

        /// <summary>The page identifies devices by UUID; Windows by a 48-bit Bluetooth address.</summary>
        public static string Uuid(ulong address) => "00000000-0000-0000-0000-" + address.ToString("X12", CultureInfo.InvariantCulture);

        public static ulong? Address(string uuid)
        {
            if (uuid == null || !Guid.TryParseExact(uuid, "D", out _) || !uuid.StartsWith("00000000-0000-0000-0000-", StringComparison.Ordinal)) return null;
            return ulong.TryParse(uuid.Substring(24), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var address) ? address : (ulong?)null;
        }

        void Post(Action action) => ui.Post(_ => action(), null);

        void Emit(string name, Dictionary<string, object> details = null)
        {
            var message = details ?? new Dictionary<string, object>();
            message["event"] = name;
            emit(message);
        }

        bool RadioOn => radio != null && radio.State == RadioState.On;

        public async void Start(ulong? address)
        {
            identifier = address; browsing = address == null;
            Emit("started", new Dictionary<string, object> { ["target"] = "", ["transport"] = "BLE MIDI" });
            ArmDeadline();
            try
            {
                var adapter = await BluetoothAdapter.GetDefaultAsync();
                if (stopping) return;
                if (adapter == null || !adapter.IsLowEnergySupported || !adapter.IsCentralRoleSupported)
                { Stop("mac_bluetooth_unsupported", 4); return; }
                var access = await Radio.RequestAccessAsync();
                if (access == RadioAccessStatus.DeniedByUser || access == RadioAccessStatus.DeniedBySystem)
                { Stop("permission_denied", 4); return; }
                radio = await adapter.GetRadioAsync();
                if (stopping) return;
                if (radio == null) { Stop("mac_bluetooth_unsupported", 4); return; }
                radio.StateChanged += (sender, args) => Post(() =>
                {
                    if (stopping || sender.State == RadioState.On) return;
                    Stop(ready || device != null ? "mac_bluetooth_reset" : "mac_bluetooth_off", 4);
                });
                if (radio.State != RadioState.On) { Stop("mac_bluetooth_off", 4); return; }
                if (identifier.HasValue && await Paired(identifier.Value)) { Connect(identifier.Value, ""); return; }
                await Scan();
            }
            catch (Exception error) { Fail("bluetooth_start", error); }
        }

        static async Task<bool> Paired(ulong address)
        {
            using (var known = await BluetoothLEDevice.FromBluetoothAddressAsync(address))
                return known != null && known.DeviceInformation.Pairing.IsPaired;
        }

        void Fail(string operation, Exception error)
        {
            if (stopping) return;
            Issue("service_failed", error);
            Stop(operation, 1);
        }

        void ArmDeadline()
        {
            deadline?.Dispose();
            var armed = ++generation;
            deadline = new System.Threading.Timer(_ => Post(() =>
            {
                if (armed != generation || stopping || ready) return;
                if (browsing && RadioOn)
                {
                    StopWatcher(); phase = "idle";
                    Emit("scan_complete"); return;
                }
                var reason = !RadioOn ? "mac_bluetooth_unavailable" : linkEstablished ? "midi_timeout" : "piano_unreachable";
                Stop(reason, 3);
            }), null, TimeSpan.FromSeconds(TimeoutSeconds), Timeout.InfiniteTimeSpan);
        }

        void Advertise(ulong address, string name, short? rssi)
        {
            var now = clock.Elapsed.TotalSeconds;
            if (lastAdvertisement.TryGetValue(address, out var last) && now - last < 1) return;
            lastAdvertisement[address] = now;
            var found = new Dictionary<string, object> { ["name"] = string.IsNullOrEmpty(name) ? "Bluetooth MIDI" : name, ["uuid"] = Uuid(address) };
            if (rssi.HasValue && rssi.Value != 127) found["rssi"] = (int)rssi.Value;
            Emit("discovered", found);
        }

        async Task Scan()
        {
            phase = "scanning";
            lastAdvertisement.Clear();
            Emit("scanning", new Dictionary<string, object> { ["browsing"] = browsing });
            // Paired pianos that are already connected to Windows may not advertise.
            try
            {
                var selector = BluetoothLEDevice.GetDeviceSelectorFromPairingState(true);
                foreach (var info in await DeviceInformation.FindAllAsync(selector))
                {
                    if (stopping || phase != "scanning") return;
                    using (var known = await BluetoothLEDevice.FromIdAsync(info.Id))
                    {
                        if (known == null) continue;
                        var services = await known.GetGattServicesForUuidAsync(ServiceUuid, BluetoothCacheMode.Cached);
                        var isMidi = services.Status == GattCommunicationStatus.Success && services.Services.Count > 0;
                        foreach (var item in services.Services) item.Dispose();
                        if (!isMidi) continue;
                        names[known.BluetoothAddress] = known.Name;
                        midiDevices.Add(known.BluetoothAddress);
                        if (browsing) Advertise(known.BluetoothAddress, known.Name, null);
                        else if (identifier == known.BluetoothAddress) { Connect(known.BluetoothAddress, known.Name); return; }
                    }
                }
            }
            catch (Exception) { }
            if (stopping || phase != "scanning") return;
            StopWatcher();
            watcher = new BluetoothLEAdvertisementWatcher { ScanningMode = BluetoothLEScanningMode.Active };
            watcher.Received += (sender, args) =>
            {
                var address = args.BluetoothAddress;
                var name = args.Advertisement.LocalName;
                var isMidi = args.Advertisement.ServiceUuids.Contains(ServiceUuid);
                var rssi = args.RawSignalStrengthInDBm;
                Post(() => Advertisement(address, name, isMidi, rssi));
            };
            watcher.Stopped += (sender, args) =>
            {
                var error = args.Error;
                Post(() =>
                {
                    if (stopping || error == BluetoothError.Success || phase != "scanning") return;
                    Stop(error == BluetoothError.RadioNotAvailable ? "mac_bluetooth_off" :
                         error == BluetoothError.DisabledByUser || error == BluetoothError.DisabledByPolicy ? "permission_denied" :
                         "mac_bluetooth_unavailable", 4);
                });
            };
            watcher.Start();
        }

        void StopWatcher()
        {
            if (watcher == null) return;
            try { watcher.Stop(); } catch (Exception) { }
            watcher = null;
        }

        void Advertisement(ulong address, string name, bool isMidi, short rssi)
        {
            // Names often arrive in the scan response, without the service UUID.
            if (!string.IsNullOrEmpty(name)) names[address] = name;
            if (isMidi) midiDevices.Add(address);
            if (!midiDevices.Contains(address) || device != null || ready || stopping || phase != "scanning") return;
            names.TryGetValue(address, out var known);
            if (browsing) { Advertise(address, known, rssi); return; }
            if (identifier != address) return;
            deviceSeen = true;
            Connect(address, known);
        }

        public Task<Dictionary<string, object>> Command(Dictionary<string, object> request)
        {
            var result = CommandNow(request);
            return Task.FromResult(result);
        }

        static Dictionary<string, object> Error(string message) => new Dictionary<string, object> { ["error"] = message };
        static Dictionary<string, object> Ok() => new Dictionary<string, object> { ["ok"] = true };

        Dictionary<string, object> CommandNow(Dictionary<string, object> request)
        {
            if (stopping) return Error("Bağlantı kapanıyor; tamamlanmasını bekle.");
            var command = request.Text("command");
            if (command == "scan")
            {
                if (device != null) return Error("Yeni tarama için önce mevcut bağlantıyı kes.");
                if (!RadioOn) return Error("Bilgisayarın Bluetooth servisi hazır değil.");
                browsing = true; identifier = null; target = "";
                ArmDeadline(); _ = Scan(); return Ok();
            }
            if (command == "connect")
            {
                if (device != null) return Error("Önce mevcut bağlantıyı kes.");
                if (!RadioOn) return Error("Bilgisayarın Bluetooth servisi hazır değil.");
                var address = Address(request.Text("uuid"));
                if (!address.HasValue) return Error("Listeden bir MIDI cihazı seç.");
                identifier = address; browsing = false;
                ArmDeadline();
                if (midiDevices.Contains(address.Value)) { names.TryGetValue(address.Value, out var name); Connect(address.Value, name); }
                else _ = Scan();
                return Ok();
            }
            return ready && output != null ? output.Command(request) : Error("Piyano bağlı değil.");
        }

        static bool AuthenticationError(byte? error) =>
            error == GattProtocolError.InsufficientAuthentication || error == GattProtocolError.InsufficientEncryption ||
            error == GattProtocolError.InsufficientAuthorization;

        async void Connect(ulong address, string name)
        {
            StopWatcher();
            phase = "connecting";
            target = string.IsNullOrEmpty(name) ? "Bluetooth MIDI" : name;
            Emit("connecting", new Dictionary<string, object> { ["name"] = target, ["uuid"] = Uuid(address) });
            try
            {
                var found = await BluetoothLEDevice.FromBluetoothAddressAsync(address);
                if (stopping) { found?.Dispose(); return; }
                device = found;
                if (device == null) { Stop("connect_failed", 1); return; }
                if (!string.IsNullOrEmpty(device.Name)) target = device.Name;
                device.ConnectionStatusChanged += (sender, args) => Post(ConnectionChanged);
                var services = await device.GetGattServicesForUuidAsync(ServiceUuid, BluetoothCacheMode.Uncached);
                if (stopping) return;
                if (services.Status != GattCommunicationStatus.Success)
                {
                    Issue(services.Status == GattCommunicationStatus.AccessDenied ? "pairing_failed" : "connect_failed", null, services.Status.ToString());
                    Stop("connect_failed", 1); return;
                }
                linkEstablished = true;
                phase = "discovering_midi_service";
                Emit("midi_discovery");
                service = services.Services.FirstOrDefault();
                foreach (var extra in services.Services.Skip(1)) extra.Dispose();
                if (service == null) { Stop("midi_service_missing", 1); return; }
                var characteristics = await service.GetCharacteristicsForUuidAsync(CharacteristicUuid, BluetoothCacheMode.Uncached);
                if (stopping) return;
                if (characteristics.Status != GattCommunicationStatus.Success)
                {
                    Issue("midi_discovery_failed", null, characteristics.Status.ToString());
                    Stop("discover_characteristics", 1); return;
                }
                midi = characteristics.Characteristics.FirstOrDefault();
                if (midi == null) { Stop("midi_characteristic_missing", 1); return; }
                phase = "authenticating_midi";
                Emit("midi_initial_read", new Dictionary<string, object> { ["properties"] = (int)midi.CharacteristicProperties });
                // BLE-MIDI 1.0 section 5: read the I/O characteristic after connecting.
                // Pianos that need encryption ask Windows to pair here.
                var read = await midi.ReadValueAsync(BluetoothCacheMode.Uncached);
                if (stopping) return;
                if ((read.Status == GattCommunicationStatus.ProtocolError && AuthenticationError(read.ProtocolError)) ||
                    read.Status == GattCommunicationStatus.AccessDenied)
                {
                    var pairing = await device.DeviceInformation.Pairing.PairAsync(DevicePairingProtectionLevel.Encryption);
                    if (stopping) return;
                    if (pairing.Status != DevicePairingResultStatus.Paired && pairing.Status != DevicePairingResultStatus.AlreadyPaired)
                    {
                        Issue("pairing_failed", null, pairing.Status.ToString());
                        Stop("midi_read_failed", 1); return;
                    }
                    read = await midi.ReadValueAsync(BluetoothCacheMode.Uncached);
                    if (stopping) return;
                }
                if (read.Status != GattCommunicationStatus.Success)
                {
                    var authorization = read.Status == GattCommunicationStatus.AccessDenied ||
                        (read.Status == GattCommunicationStatus.ProtocolError && AuthenticationError(read.ProtocolError));
                    Issue(authorization ? "pairing_failed" : "midi_read_failed", null, read.Status + " " + read.ProtocolError);
                    Stop("midi_read_failed", 1); return;
                }
                Emit("midi_handshake_complete", new Dictionary<string, object> { ["bytes"] = (int)(read.Value?.Length ?? 0) });
                phase = "subscribing";
                midi.ValueChanged += Received;
                var subscribed = await midi.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify);
                if (stopping) return;
                if (subscribed != GattCommunicationStatus.Success)
                {
                    Issue("midi_subscription_failed", null, subscribed.ToString());
                    Stop("midi_subscription_failed", 1); return;
                }
                ready = true;
                generation++; deadline?.Dispose(); deadline = null;
                phase = "listening";
                var connected = device;
                output = new BleMidiOutput(midi, () => connected.ConnectionStatus == BluetoothConnectionStatus.Connected,
                    message => Post(() => Emit("output_error", new Dictionary<string, object> { ["message"] = message })));
                var outputCapable = (midi.CharacteristicProperties & GattCharacteristicProperties.WriteWithoutResponse) != 0;
                Emit("ready", new Dictionary<string, object>
                {
                    ["name"] = target, ["target"] = target, ["input_capable"] = true, ["uuid"] = Uuid(address), ["output_capable"] = outputCapable,
                });
            }
            catch (Exception error)
            {
                if (stopping) return;
                Issue("connect_failed", error);
                Stop("connect_failed", 1);
            }
        }

        void ConnectionChanged()
        {
            if (device == null || device.ConnectionStatus != BluetoothConnectionStatus.Disconnected) return;
            if (stopping || !linkEstablished) return;
            Issue("connection_lost", null);
            Stop("bluetooth_disconnected", 5);
        }

        void Received(GattCharacteristic sender, GattValueChangedEventArgs args)
        {
            CryptographicBuffer.CopyToByteArray(args.CharacteristicValue, out var bytes);
            var received = clock.Elapsed.TotalSeconds;
            Post(() =>
            {
                if (stopping || !ready || bytes == null) return;
                var invalid = decoder.Decode(bytes, (status, first, second, timestamp) => Message(status, first, second, timestamp, received));
                if (invalid == null) return;
                Issue("invalid_ble_midi", null, invalid);
                Stop("invalid_ble_midi", 1);
            });
        }

        static readonly string[] NoteNames = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };

        void Message(byte status, byte first, byte second, ushort timestamp, double received)
        {
            if (stopping) return;
            var kind = status & 0xF0;
            var value = new Dictionary<string, object>
            {
                ["channel"] = (status & 15) + 1, ["device_time_ms"] = (int)timestamp, ["received_monotonic_seconds"] = received,
            };
            if (kind == 0x80 || kind == 0x90)
            {
                value["note"] = (int)first;
                value["name"] = NoteNames[first % 12] + (first / 12 - 1);
                value["velocity"] = (int)second;
                Emit(kind == 0x90 && second != 0 ? "note_on" : "note_off", value);
            }
            else if (kind == 0xB0)
            {
                value["controller"] = (int)first; value["value"] = (int)second;
                if (first == 64 || first == 66 || first == 67)
                {
                    value["pedal"] = first == 64 ? "sustain" : first == 66 ? "sostenuto" : "soft";
                    value["pressed"] = second >= 64;
                    Emit("pedal", value);
                }
                else Emit("control_change", value);
            }
            else
            {
                value["status"] = (int)status; value["data1"] = (int)first; value["data2"] = (int)second;
                Emit("midi_message", value);
            }
        }

        void Issue(string code, Exception error, string detail = null)
        {
            if (diagnostic != null) return; // Cleanup must not erase the original cause.
            diagnostic = new Dictionary<string, object>
            {
                ["code"] = code, ["stage"] = phase, ["deviceSeen"] = deviceSeen, ["linkEstablished"] = linkEstablished,
            };
            if (error != null)
            {
                diagnostic["domain"] = error.GetType().Name;
                diagnostic["osCode"] = error.HResult;
                diagnostic["detail"] = error.Message;
            }
            else if (detail != null) diagnostic["detail"] = detail;
            Emit("connection_issue", new Dictionary<string, object> { ["diagnostic"] = diagnostic.Copy() });
        }

        public async void Stop(string reason, int code)
        {
            if (stopping) return;
            if (code != 0) Issue(reason, null);
            stopping = true;
            phase = "stopping";
            stopReason = reason; exitCode = code;
            generation++; deadline?.Dispose(); deadline = null;
            StopWatcher();
            if (output != null)
            {
                phase = "disconnecting";
                // Drain our note-offs and sustain release before closing our BLE link.
                output.Stop();
                var started = clock.Elapsed.TotalSeconds;
                while (!output.Drained && clock.Elapsed.TotalSeconds - started < 1) await Task.Delay(10);
                if (!output.Drained)
                    Emit("output_error", new Dictionary<string, object> { ["message"] = "Nota bırakma gönderimi tamamlanmadan bağlantı kapanıyor." });
                await Task.Delay(100);
            }
            if (midi != null)
            {
                midi.ValueChanged -= Received;
                try
                {
                    var unsubscribe = midi.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.None).AsTask();
                    await Task.WhenAny(unsubscribe, Task.Delay(1000));
                }
                catch (Exception) { }
            }
            // Windows closes the link when no app holds the device any more.
            service?.Dispose(); service = null; midi = null;
            device?.Dispose(); device = null;
            Finish();
        }

        void Finish()
        {
            if (finished) return;
            finished = true;
            var result = new Dictionary<string, object> { ["reason"] = stopReason, ["exit_code"] = exitCode, ["own_connection_closed"] = true };
            if (diagnostic != null)
            {
                var copy = diagnostic.Copy();
                copy["cleanupConfirmed"] = true;
                result["diagnostic"] = copy;
            }
            Emit("stopped", result);
            exited(exitCode);
        }
    }
}
