"""Local PianoMan HTTP service and native Bluetooth process owner."""
import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import signal
import socket
import sys
from urllib.parse import urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "bluetooth-connection"))
from bluetooth_bridge import BluetoothBridge, prepare_native
from desktop.lesson_bridge import LessonBridge

FILES = {
    "/i18n.js": ("i18n.js", "text/javascript; charset=utf-8"),
    "/i18n-messages.js": ("i18n-messages.js", "text/javascript; charset=utf-8"),
    "/bluetooth-diagnostics.js": ("bluetooth-connection/bluetooth-diagnostics.js", "text/javascript; charset=utf-8"),
    "/piano-output.js": ("piano-output.js", "text/javascript; charset=utf-8"),
    "/workspace-state.js": ("workspace-state.js", "text/javascript; charset=utf-8"),
    "/sheet-music.js": ("sheet-music.js", "text/javascript; charset=utf-8"),
    "/assets/notation/verovio-toolkit-wasm.js": ("assets/notation/verovio-toolkit-wasm.js", "text/javascript; charset=utf-8"),
    "/app-shell.js": ("app-shell.js", "text/javascript; charset=utf-8"),
    "/create-lesson.js": ("create-lesson.js", "text/javascript; charset=utf-8"),
    "/staff-notation.js": ("staff-notation.js", "text/javascript; charset=utf-8"),
    "/assets/bravura/Bravura.woff2": ("assets/bravura/Bravura.woff2", "font/woff2"),
    "/desktop.js": ("desktop.js", "text/javascript; charset=utf-8"),
    "/development.js": ("desktop/development.js", "text/javascript; charset=utf-8"),
    "/": ("piano.html", "text/html; charset=utf-8"),
    "/piano.html": ("piano.html", "text/html; charset=utf-8"),
    "/player.js": ("player.js", "text/javascript; charset=utf-8"),
    "/piano-input.js": ("piano-input.js", "text/javascript; charset=utf-8"),
    "/practice-clock.js": ("practice-clock.js", "text/javascript; charset=utf-8"),
    "/bluetooth.js": ("bluetooth-connection/bluetooth.js", "text/javascript; charset=utf-8"),
    "/transcription.json": ("transcription.json", "application/json; charset=utf-8"),
    "/a-small-measure-of-peace-video.mid": ("a-small-measure-of-peace-video.mid", "audio/midi"),
}


class PianoHandler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        # Polling is normal activity, not a diagnostic stream to retain on disk.
        if code == HTTPStatus.OK and urlsplit(self.path).path in ("/api/development", "/api/lessons/command", "/api/bluetooth/output"):
            return
        super().log_request(code, size)

    def allowed(self, mutation=False):
        hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in hosts or (origin is not None and origin != f"http://{host}"):
            self.send_error(HTTPStatus.FORBIDDEN)
            return False
        if mutation and (self.headers.get("X-PianoMan") != "1" or
                         self.headers.get_content_type() != "application/json"):
            self.send_error(HTTPStatus.FORBIDDEN)
            return False
        return True

    def send_content(self, content, content_type, include_body=True, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(content)

    def send_json(self, data, status=HTTPStatus.OK, include_body=True):
        self.send_content(json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8", include_body, status)

    def do_GET(self):
        self.respond(True)

    def do_HEAD(self):
        self.respond(False)

    def respond(self, include_body):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path == "/api/bluetooth/events" and include_body:
            self.events()
        elif path == "/api/bluetooth/status":
            self.send_json(self.server.bluetooth.snapshot(), include_body=include_body)
        elif path == "/api/status":
            self.send_json({"service": "pianoman", "status": "ok"}, include_body=include_body)
        elif path == "/api/development" and self.server.development:
            revision = [(name, (ROOT/name).stat().st_mtime_ns) for name in sorted({entry[0] for entry in FILES.values()})]
            self.send_json({"revision": revision}, include_body=include_body)
        elif path in FILES:
            filename, content_type = FILES[path]
            try:
                content = (ROOT / filename).read_bytes()
                if filename == "piano.html" and self.server.development:
                    content = content.replace(b"</head>", b'<script src="/development.js" defer></script></head>')
            except OSError:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Page file unavailable")
                return
            self.send_content(content, content_type, include_body)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        if not self.allowed(mutation=True):
            return
        path = urlsplit(self.path).path
        if path == "/api/bluetooth/output":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 4*1024*1024: raise ValueError("Geçersiz MIDI istek boyutu")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict) or request.get("command") not in (
                        "output-start", "output-stop", "output-heartbeat"):
                    raise ValueError("Geçersiz MIDI çıkış komutu")
                self.send_json(self.server.bluetooth.output(request))
            except (ValueError, RuntimeError) as error:
                self.send_json({"error":str(error)}, HTTPStatus.CONFLICT)
            return
        if path == "/api/lessons/command":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length<=0 or length>3*1024*1024:
                    raise ValueError("Geçersiz istek boyutu")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request,dict) or request.get("command") not in (
                        "lesson-state","lesson-list","lesson-load","lesson-delete","lesson-begin",
                        "lesson-chunk","lesson-start","lesson-cancel"):
                    raise ValueError("Geçersiz ders komutu")
                self.send_json(self.server.lessons.call(request))
            except (ValueError, OSError, RuntimeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)
            return
        actions = {"/api/bluetooth/connect": self.server.bluetooth.connect,
                   "/api/bluetooth/scan": self.server.bluetooth.scan,
                   "/api/bluetooth/disconnect": self.server.bluetooth.disconnect}
        if path not in actions:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4096: raise ValueError("Geçersiz Bluetooth isteği")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict): raise ValueError("Geçersiz Bluetooth isteği")
            self.send_json(actions[path](request.get("uuid")) if path.endswith("/connect") else actions[path]())
        except (ValueError, RuntimeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)

    def events(self):
        try:
            client = self.server.bluetooth.subscribe()
        except RuntimeError:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            self.connection.settimeout(3)
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            while True:
                try:
                    event = client.get(timeout=1)
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                else:
                    if event is None:
                        break
                    self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
        except (OSError, TimeoutError):
            pass
        finally:
            self.server.bluetooth.unsubscribe(client)


def stop(_signum, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description="PianoMan yerel web servisi")
    parser.add_argument("--port", type=int, default=8783)
    parser.add_argument("--open", action="store_true", help="Sayfayı tarayıcıda aç")
    parser.add_argument("--dev", action="store_true", help="Kaynak değişince tarayıcıyı yenile")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), PianoHandler)
    except OSError as error:
        parser.exit(1, f"Servis başlatılamadı: {error}\n")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    with server:
        try:
            prepare_native()
            server.bluetooth = BluetoothBridge()
            server.lessons = LessonBridge()
            server.development = args.dev
            address = f"http://127.0.0.1:{server.server_port}"
            print(f"PianoMan: {address}\nDurdurmak için Ctrl+C.", flush=True)
            if args.open:
                webbrowser.open(address)
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            print("\nPianoMan servisi durduruluyor…", flush=True)
        finally:
            if hasattr(server, "bluetooth"):
                server.bluetooth.close()
            if hasattr(server, "lessons"):
                server.lessons.close()


if __name__ == "__main__":
    main()
