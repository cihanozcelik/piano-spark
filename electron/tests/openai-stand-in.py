# A stand-in for OpenAI's Responses API, for electron/tests/customize.test.js.
# First answer: run the JavaScript in SCRIPT with Codex's "exec" tool. Then: say "done".
# Logs every request. Nothing leaves the computer.
#   python openai-stand-in.py PORT LOG SCRIPT
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]); LOG = sys.argv[2]; SCRIPT = open(sys.argv[3], encoding="utf-8").read()

def sse(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self): self.send_response(404); self.end_headers()
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        items = body.get("input", [])
        # Only what came after the person's last message counts.
        last = max([n for n, i in enumerate(items) if i.get("role") == "user"] or [0])
        outputs = [i for i in items[last:] if i.get("type") in ("function_call_output", "custom_tool_call_output")]
        tools = {t.get("name"): t.get("type") for t in body.get("tools", [])}
        with open(LOG, "a", encoding="utf-8") as f: f.write(json.dumps({"path": self.path, "auth": self.headers.get("Authorization"), "tools": tools, "outputs": outputs}) + "\n")
        rid = f"resp_{len(items)}"
        if outputs:
            item = {"type": "message", "role": "assistant", "id": "msg_1", "content": [{"type": "output_text", "text": "done"}]}
        elif tools.get("exec") == "custom":
            item = {"type": "custom_tool_call", "id": "ctc_1", "call_id": "call_1", "name": "exec", "input": SCRIPT}
        else:
            item = {"type": "message", "role": "assistant", "id": "msg_1", "content": [{"type": "output_text", "text": "this Codex offers no exec tool"}]}
        data = sse([{"type": "response.created", "response": {"id": rid}},
                    {"type": "response.output_item.done", "item": item},
                    {"type": "response.completed", "response": {"id": rid, "usage": {"input_tokens": 10, "input_tokens_details": None,
                        "output_tokens": 5, "output_tokens_details": None, "total_tokens": 15}}}])
        self.send_response(200); self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
