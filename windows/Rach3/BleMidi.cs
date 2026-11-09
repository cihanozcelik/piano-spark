using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Security.Cryptography;

namespace Rach3
{
    /// <summary>BLE-MIDI 1.0 packet decoder; a line-by-line port of bluetooth-connection/BLEMIDI.m.</summary>
    sealed class BleMidiDecoder
    {
        bool sysex;

        public delegate void Message(byte status, byte first, byte second, ushort timestamp);

        string Invalid(string message, int position)
        {
            sysex = false;
            return message + " (byte " + position + ")";
        }

        /// <summary>Returns null when the packet is valid, otherwise the reason.</summary>
        public string Decode(byte[] bytes, Message handler)
        {
            var length = bytes.Length;
            if (length == 0) return null;
            if ((bytes[0] & 0xC0) != 0x80) return Invalid("Invalid BLE-MIDI header", 0);
            int high = bytes[0] & 0x3F, previousLow = -1;
            byte running = 0;
            ushort timestamp = 0;
            var timestampRequired = true;
            var position = 1;
            while (position < length)
            {
                // Only SysEx may continue across packets. Its payload is deliberately not retained.
                if (sysex && bytes[position] < 0x80) { position++; continue; }
                var hasTimestamp = bytes[position] >= 0x80;
                if (hasTimestamp)
                {
                    var low = bytes[position++] & 0x7F;
                    if (previousLow >= 0 && low < previousLow) high = (high + 1) & 0x3F;
                    previousLow = low;
                    timestamp = (ushort)((high << 7) | low);
                    if (position == length) return Invalid("Timestamp without MIDI message", position);
                }
                else if (timestampRequired) return Invalid("Missing MIDI timestamp", position);
                byte status;
                if (bytes[position] >= 0x80)
                {
                    if (!hasTimestamp) return Invalid("Status without timestamp", position);
                    status = bytes[position++];
                }
                else
                {
                    if (running == 0 || sysex) return Invalid("Running status without a channel message", position);
                    status = running;
                }
                if (sysex)
                {
                    if (status == 0xF7) sysex = false;
                    else if (status < 0xF8) return Invalid("Unexpected status inside SysEx", position - 1);
                    timestampRequired = true;
                    continue;
                }
                if (status == 0xF0) { sysex = true; timestampRequired = true; continue; }
                // Timing clock/active sensing are not piano key or pedal events.
                if (status >= 0xF8) { timestampRequired = true; continue; }
                int count;
                if (status < 0xF0)
                {
                    running = status;
                    var kind = status & 0xF0;
                    count = kind == 0xC0 || kind == 0xD0 ? 1 : 2;
                    timestampRequired = false;
                }
                else
                {
                    count = status == 0xF2 ? 2 : status == 0xF1 || status == 0xF3 ? 1 : 0;
                    timestampRequired = true;
                }
                if (position + count > length) return Invalid("Truncated MIDI message", position);
                for (var i = 0; i < count; i++)
                    if (bytes[position + i] >= 0x80) return Invalid("Status inside MIDI data", position + i);
                var first = count > 0 ? bytes[position] : (byte)0;
                var second = count > 1 ? bytes[position + 1] : (byte)0;
                position += count;
                handler(status, first, second, timestamp);
            }
            return null;
        }
    }

    /// <summary>
    /// Scheduled lesson playback to the piano; a port of bluetooth-connection/BLEMIDIOutput.m.
    /// A dedicated thread sends due events, so playback timing never waits for the window.
    /// </summary>
    sealed class BleMidiOutput
    {
        readonly GattCharacteristic characteristic;
        readonly Action<string> onError;
        readonly Func<bool> connected;
        readonly object gate = new object();
        readonly int[,] held = new int[16, 128];
        readonly bool[] used = new bool[16];
        readonly Stopwatch clock = Stopwatch.StartNew();
        List<double[]> events, releases;
        int index, releaseIndex;
        string session;
        double anchor, lease, end;
        Thread sender;

        public BleMidiOutput(GattCharacteristic characteristic, Func<bool> connected, Action<string> onError)
        {
            this.characteristic = characteristic; this.connected = connected; this.onError = onError;
        }

        double Now => clock.Elapsed.TotalSeconds;
        public bool Drained { get { lock (gate) return releases == null || releaseIndex >= releases.Count; } }
        bool CanWrite => (characteristic.CharacteristicProperties & GattCharacteristicProperties.WriteWithoutResponse) != 0;

        static Dictionary<string, object> Error(string message) => new Dictionary<string, object> { ["error"] = message };
        static Dictionary<string, object> Ok() => new Dictionary<string, object> { ["ok"] = true };

        public Dictionary<string, object> Command(Dictionary<string, object> request)
        {
            var kind = request.Text("command");
            var requested = request.Text("session");
            if (string.IsNullOrEmpty(requested) || requested.Length > 80) return Error("Geçersiz çalma oturumu.");
            lock (gate)
            {
                if (kind == "output-stop")
                {
                    if (session == requested) StopLocked();
                    return Ok();
                }
                if (kind == "output-heartbeat")
                {
                    if (session == requested) lease = Now;
                    return Ok();
                }
                if (kind != "output-start") return Error("Geçersiz MIDI çıkış komutu.");
                if (session != null || !(releases == null || releaseIndex >= releases.Count)) return Error("Önce mevcut piyano çalmasını durdur.");
                if (!connected() || !CanWrite) return Error("Bu bağlantıda MIDI gönderimi hazır değil.");
                var list = request.TryGetValue("events", out var raw) ? raw as IList : null;
                var duration = request.TryGetValue("duration", out var rawDuration) ? ToDouble(rawDuration) : double.NaN;
                if (list == null || list.Count > 100000 || double.IsNaN(duration) || double.IsInfinity(duration) || duration < 0 || duration > 86400)
                    return Error("Ders MIDI çıkışı için çok büyük veya geçersiz.");
                var parsed = new List<double[]>(list.Count);
                var previous = -1.0;
                foreach (var item in list)
                {
                    if (!(item is IList values) || values.Count != 4) return Error("Geçersiz MIDI olayı.");
                    var numbers = new double[4];
                    for (var i = 0; i < 4; i++)
                    {
                        numbers[i] = ToDouble(values[i]);
                        if (double.IsNaN(numbers[i])) return Error("Geçersiz MIDI değeri.");
                    }
                    double at = numbers[0], status = numbers[1], first = numbers[2], second = numbers[3];
                    var type = (int)status & 0xF0;
                    if (double.IsInfinity(at) || at < previous || at < 0 || at > duration ||
                        status != Math.Floor(status) || first != Math.Floor(first) || second != Math.Floor(second) ||
                        (type != 0x80 && type != 0x90 && type != 0xB0) || status > 255 || status < 0 ||
                        first < 0 || first > 127 || second < 0 || second > 127 || (type == 0xB0 && first != 64))
                        return Error("Desteklenmeyen MIDI olayı.");
                    previous = at;
                    parsed.Add(numbers);
                }
                events = parsed; index = 0; session = requested;
                lease = Now; anchor = lease + .12; end = duration;
                StartSender();
                return new Dictionary<string, object>
                {
                    ["ok"] = true, ["start_unix_ms"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 120,
                };
            }
        }

        static double ToDouble(object value)
        {
            if (value == null || value is bool || value is string || !(value is IConvertible number)) return double.NaN;
            return Convert.ToDouble(number, CultureInfo.InvariantCulture);
        }

        void StartSender()
        {
            if (sender != null) return;
            sender = new Thread(Run) { IsBackground = true, Priority = ThreadPriority.AboveNormal, Name = "BLE-MIDI output" };
            sender.Start();
        }

        void Run()
        {
            timeBeginPeriod(1);
            try
            {
                while (true)
                {
                    lock (gate) { if (!Flush()) { sender = null; return; } }
                    Thread.Sleep(1);
                }
            }
            finally { timeEndPeriod(1); }
        }

        void Write(double[] message)
        {
            byte status = (byte)message[1], first = (byte)message[2], second = (byte)message[3];
            int channel = status & 15, type = status & 0xF0;
            if (type == 0x80 || (type == 0x90 && second == 0))
            {
                if (held[channel, first] > 1) { held[channel, first]--; return; }
                held[channel, first] = 0;
            }
            else if (type == 0x90) held[channel, first]++;
            used[channel] = true;
            var timestamp = (int)((long)(Now * 1000) & 8191);
            var packet = new byte[] { (byte)(0x80 | (timestamp >> 7)), (byte)(0x80 | (timestamp & 127)), status, first, second };
            try
            {
                characteristic.WriteValueAsync(CryptographicBuffer.CreateFromByteArray(packet), GattWriteOption.WriteWithoutResponse).AsTask().Wait();
            }
            catch (Exception) { }
        }

        /// <summary>Send what is due. Returns false when nothing is left to send.</summary>
        bool Flush()
        {
            if (!connected()) { session = null; events = null; releases = null; return false; }
            var now = Now;
            if (session != null && now - lease > 2)
            {
                StopLocked(); onError("Çalma sayfasıyla iletişim kesildi; piyano çalması durduruldu."); return true;
            }
            while (releases != null && releaseIndex < releases.Count) Write(releases[releaseIndex++]);
            if (releases != null)
            {
                releases = null; releaseIndex = 0;
                Array.Clear(used, 0, used.Length);
            }
            if (session == null) return false;
            var time = now - anchor;
            if (index < events.Count && time - events[index][0] > .35)
            {
                StopLocked(); onError("Bluetooth MIDI gönderimi gecikti; çalma durduruldu."); return true;
            }
            while (index < events.Count && events[index][0] <= time) Write(events[index++]);
            if (index == events.Count && time >= end) StopLocked();
            return true;
        }

        public void Stop() { lock (gate) StopLocked(); }

        void StopLocked()
        {
            session = null; events = null;
            var pending = new List<double[]>();
            for (var channel = 0; channel < 16; channel++)
            {
                if (!used[channel]) continue;
                pending.Add(new double[] { 0, 0xB0 | channel, 64, 0 });
                for (var pitch = 0; pitch < 128; pitch++)
                {
                    if (held[channel, pitch] == 0) continue;
                    held[channel, pitch] = 1;
                    pending.Add(new double[] { 0, 0x80 | channel, pitch, 0 });
                }
            }
            releases = pending; releaseIndex = 0;
            StartSender();
        }

        [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
        [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
    }
}
