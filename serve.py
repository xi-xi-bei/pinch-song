import http.server
import urllib.request
import urllib.error
import ssl
import os
import socketserver

PORT = 8765
DIR = os.path.dirname(os.path.abspath(__file__))

PROXY_MAP = {
    "/jsd/": "https://cdn.jsdelivr.net/",
    "/npm/": "https://registry.npmmirror.com/",
    "/models/": "https://storage.googleapis.com/mediapipe-models/",
}

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        # Required for SharedArrayBuffer (MediaPipe WASM)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def guess_type(self, path):
        ctype = super().guess_type(path)
        if path.endswith(".html") or path == "/":
            return "text/html; charset=utf-8"
        return ctype

    def do_GET(self):
        for prefix, target in PROXY_MAP.items():
            if self.path.startswith(prefix):
                return self._proxy(prefix, target)
        return super().do_GET()

    def _proxy(self, prefix, target_base):
        remote_path = self.path[len(prefix):]
        url = target_base + remote_path
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                data = resp.read()
                self.send_response(200)
                ct = resp.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", ct)
                self.send_header("Content-Length", len(data))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_error(502, f"Proxy error: {e}")

    def log_message(self, format, *args):
        pass  # quiet

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

print(f"Serving on http://localhost:{PORT}")
server = ThreadedHTTPServer(("127.0.0.1", PORT), ProxyHandler)
try:
    server.serve_forever()
except KeyboardInterrupt:
    server.server_close()
