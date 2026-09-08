"""
Serve the planner locally, with caching turned off.

    python serve.py [port]        # default 8000

Plain `python -m http.server` lets the browser cache the scripts and the
stylesheet. Editing a file and reloading then shows the OLD version, with no
error and nothing to suggest the file on disk is not what is running - the
failure looks like "my change did nothing" rather than like a cache.

Every response here carries `Cache-Control: no-store`, so a reload always
fetches what is on disk. The files are local, so there is nothing to gain from
caching them anyway.
"""

import http.server, os, socketserver, sys, webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Only failures. A successful fetch of every asset on every reload is
        # noise that hides the one line that matters.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    os.chdir(ROOT)
    url = f"http://localhost:{PORT}"
    print(f"\n  Nuclear Option Mission Planner\n  {url}\n  Ctrl+C to stop.\n")
    webbrowser.open(url)
    try:
        with Server(("127.0.0.1", PORT), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    except OSError as e:
        sys.exit(f"could not listen on {PORT}: {e}\n"
                 f"Another server may already be using it.")
