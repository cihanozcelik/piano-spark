"""Own one native BLE MIDI process and fan its events out to local pages."""
import json
import queue
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEVICE_FILE = HERE / ".runtime/last-device.json"


def prepare_native():
    binary = HERE / "build/Rach3 Bluetooth.app/Contents/MacOS/rach3-bluetooth"
    sources = [HERE / name for name in ("main.m", "BLEMIDI.m", "BLEMIDI.h", "BLEMIDIOutput.m", "BLEMIDIOutput.h", "Info.plist", "build.sh")]
    if not binary.exists() or any(path.stat().st_mtime > binary.stat().st_mtime for path in sources):
        subprocess.run([str(HERE / "build.sh")], check=True, timeout=90)


class BluetoothBridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.commands = threading.Lock()
        self.process = None
        self.reader = None
        self.closed = False
        self.clients = set()
        self.last_client = time.monotonic()
        self.held = {}
        self.state = {"phase": "disconnected", "connected": False, "message": "Piyano bağlı değil",
                      "device": "", "uuid": None, "devices": [], "input_capable": False, "note_count": 0, "last_note": None, "pedal": None, "active": False}
        try:
            remembered = json.loads(DEVICE_FILE.read_text())["uuid"]
        except (OSError, ValueError, KeyError):
            remembered = None
        self.state["remembered_device"] = remembered
        self.shutdown = threading.Event()
        self.monitor = threading.Thread(target=self._watch_clients, daemon=True)
        self.monitor.start()

    def snapshot(self):
        with self.lock:
            return {"event": "snapshot", "status": dict(self.state), "held": list(self.held.values())}

    def _publish(self, event):
        # Called under lock. A slow page reconnects and receives an atomic snapshot.
        for client in tuple(self.clients):
            try:
                client.put_nowait(event)
            except queue.Full:
                self.clients.remove(client)
                while not client.empty():
                    client.get_nowait()
                client.put_nowait(None)
                self.last_client = time.monotonic()

    def _status(self, phase, message, diagnostic=None):
        if diagnostic is not None: self.state["diagnostic"] = diagnostic
        self.state.update(phase=phase, connected=phase == "connected", message=message)
        if phase != "connected":
            self.state["output_capable"] = False
            self.state["input_capable"] = False
            self.held.clear()
            self.state["pedal"] = None
        self._publish({"event": "status", "status": dict(self.state)})

    def subscribe(self):
        client = queue.Queue(maxsize=512)
        with self.lock:
            if self.closed:
                raise RuntimeError("Servis kapanıyor")
            self.clients.add(client)
            client.put_nowait(self.snapshot())
        return client

    def unsubscribe(self, client):
        with self.lock:
            self.clients.discard(client)
            self.last_client = time.monotonic()

    def scan(self):
        return self._start(None)

    def connect(self, identifier):
        try: identifier = str(uuid.UUID(identifier)).upper()
        except (ValueError, TypeError, AttributeError): raise RuntimeError("Listeden bir MIDI cihazı seç.")
        return self._start(identifier)

    def _start(self, identifier):
        with self.commands, self.lock:
            if self.closed:
                raise RuntimeError("Servis kapanıyor")
            if not self.clients:
                raise RuntimeError("Sayfanın canlı bağlantısı hazır değil; tekrar dene")
            if self.process is not None:
                if self.state["phase"] not in ("scanning", "idle"):
                    raise RuntimeError("Önce mevcut bağlantıyı kes.")
                self._send_command({"command": "connect", "uuid": identifier} if identifier else {"command": "scan"})
                return self.snapshot()
            self.state.update(note_count=0, last_note=None, active=True)
            self.state.pop("diagnostic", None)
            self.state["uuid"] = identifier
            self.state["devices"] = []
            self.state["device"] = ""
            self.state["browsing"] = identifier is None
            self._status("starting", "Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.")
            command = [str(HERE / "piano"), "start", "--timeout", "45", "--duration", "0"]
            if identifier:
                command += ["--uuid", identifier]
            try:
                prepare_native()
                self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                text=True, encoding="utf-8", bufsize=1)
            except (OSError, subprocess.SubprocessError) as error:
                self.state["active"] = False
                self._status("error", "Bluetooth bağlantı servisi başlatılamadı.",
                             {"code":"service_failed", "detail":str(error)})
                raise RuntimeError(self.state["message"]) from error
            self.reader = threading.Thread(target=self._read, args=(self.process,), daemon=True)
            self.reader.start()
            return self.snapshot()

    def _read(self, process):
        final = None
        diagnostics = []
        try:
            for line in process.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    diagnostics.append(line.strip()[:400])
                    diagnostics = diagnostics[-3:]
                    continue
                kind = event.get("event")
                with self.lock:
                    if kind == "stopped":
                        final = event
                        if event.get("diagnostic"):
                            self._status("error", "Bluetooth bağlantısı tamamlanamadı.", event["diagnostic"])
                    elif kind == "connection_issue":
                        self._status("error", "Bluetooth bağlantısı tamamlanamadı.", event["diagnostic"])
                    elif kind == "error":
                        diagnostic=self.state.get("diagnostic") or {"code":"service_failed",
                            "detail":event.get("message", ""), "stage":event.get("operation", ""), "osCode":event.get("code")}
                        self._status("error", "Bluetooth bağlantı servisinde sorun oluştu.", diagnostic)
                    elif kind == "connection_timeout":
                        self._status("error", "Piyanoya ulaşılamadı. Açık, Bluetooth On ve yakında olduğunu kontrol edip tekrar bağlan.")
                    elif kind == "disconnected":
                        self._status("disconnected", "Piyano bağlantısı kesildi")
                    elif kind == "output_error":
                        self._publish(event)
                    elif self.state["phase"] == "stopping":
                        continue
                    elif kind == "ready":
                        self.state.pop("diagnostic", None)
                        self.state["output_capable"] = event.get("output_capable", False)
                        self.state["uuid"] = event["uuid"]
                        self.state["device"] = event.get("name", "Bluetooth MIDI")
                        self.state["input_capable"] = event.get("input_capable", True)
                        self._status("connected", "MIDI bağlantısı hazır")
                    elif kind == "discovered":
                        devices = [item for item in self.state["devices"] if item["uuid"] != event["uuid"]]
                        devices.append({key: event[key] for key in ("uuid", "name", "rssi", "time_unix") if key in event})
                        self.state["devices"] = devices
                        self._publish({"event": "status", "status": dict(self.state)})
                    elif kind == "scan_complete":
                        self._status("idle", "Tarama tamamlandı. Listeden bir piyano seç veya yeniden tara.")
                    elif kind in ("note_on", "note_off") and self.state["connected"]:
                        key = (event.get("channel", 1), event["note"])
                        if kind == "note_on" and event.get("velocity", 0) > 0:
                            self.held[key] = event
                            self.state["note_count"] += 1
                            self.state["last_note"] = {k: event[k] for k in ("note", "name", "velocity")}
                        else:
                            self.held.pop(key, None)
                        self._publish(event)
                    elif kind == "pedal" and self.state["connected"]:
                        if event["pedal"] == "sustain":
                            self.state["pedal"] = event
                        self._publish(event)
                    elif kind == "control_change" and event.get("controller") in (120, 123):
                        channel = event.get("channel", 1)
                        for key, note in list(self.held.items()):
                            if key[0] == channel:
                                self.held.pop(key)
                                self._publish(dict(note, event="note_off", velocity=0))
                    elif kind == "connecting":
                        self.state["uuid"] = event["uuid"]
                        self.state["device"] = event["name"]
                        self.state["browsing"] = False
                        self._status("connecting", "Seçilen piyanoya bağlanılıyor…")
                    elif kind == "scanning":
                        self.state["devices"] = []
                        self.state["browsing"] = event.get("browsing", False)
                        self._status("scanning" if self.state["browsing"] else "connecting",
                                     "Yakındaki Bluetooth MIDI cihazları aranıyor…" if self.state["browsing"] else "Seçilen piyano aranıyor…")
                    elif kind == "bluetooth_waiting":
                        self._status("starting", "Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.")
                    elif kind == "midi_discovery":
                        self._status("connecting", "Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…")
                    elif kind == "midi_initial_read":
                        self._status("connecting", "MIDI bağlantısı hazırlanıyor… Gerekirse macOS onayını ver.")
        finally:
            process.stdout.close()
            code = process.wait()
            with self.lock:
                self.process = None
                self.state["active"] = False
                if self.state["phase"] == "error":
                    self._status("error", self.state["message"])
                elif final and not final.get("own_connection_closed", False):
                    self._status("error", "macOS bağlantının kapandığını doğrulamadı.", {"code":"disconnect_unconfirmed"})
                elif code:
                    detail = " · ".join(diagnostics)
                    self._status("error", "Bluetooth bağlantı servisi kapandı.",
                                 {"code":"service_failed", "detail":detail, "osCode":code})
                else:
                    self._status("disconnected", "Piyano bağlantısı kapalı")

    def disconnect(self, unattended=False):
        with self.commands:
            with self.lock:
                if unattended and (self.clients or time.monotonic() - self.last_client < 5):
                    return self.snapshot()
                process, reader = self.process, self.reader
                if process is None:
                    self._status("disconnected", "Piyano bağlantısı kapalı")
                    return self.snapshot()
                self._status("stopping", "Bağlantı kapatılıyor…")
                if process.poll() is None:
                    process.terminate()  # SIGTERM invokes native asynchronous BLE cleanup.
            reader.join(timeout=7)
            with self.lock:
                if reader.is_alive():
                    self._status("error", "Bluetooth programının kapanışı henüz tamamlanmadı; zorla kapatılmadı.")
                return self.snapshot()

    def output(self, request):
        with self.commands:
            with self.lock:
                if not self.state["connected"] or self.closed:
                    raise RuntimeError("Piyano bağlı değil")
            return self._send_command(request)

    def _send_command(self, request):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(3)
                connection.connect(str(HERE / ".runtime/control.sock"))
                connection.sendall((json.dumps(request)+"\n").encode())
                reply = bytearray()
                while True:
                    chunk = connection.recv(4096)
                    if not chunk: break
                    reply.extend(chunk)
                    if len(reply)>65536: raise RuntimeError("Geçersiz MIDI çıkış yanıtı")
            result = json.loads(reply)
        except (OSError, ValueError) as error:
            raise RuntimeError(f"Piyano MIDI gönderimi başarısız: {error}") from error
        if result.get("error"): raise RuntimeError(result["error"])
        return result

    def _watch_clients(self):
        while not self.shutdown.wait(1):
            with self.lock:
                unattended = self.process is not None and not self.clients and time.monotonic() - self.last_client >= 5
            if unattended:
                self.disconnect(unattended=True)

    def close(self):
        with self.lock:
            self.closed = True
        self.shutdown.set()
        self.disconnect()
        with self.lock:
            for client in tuple(self.clients):
                while not client.empty():
                    client.get_nowait()
                client.put_nowait(None)
            self.clients.clear()
        self.monitor.join(timeout=8)
