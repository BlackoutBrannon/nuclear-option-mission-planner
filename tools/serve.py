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

# A bare number sets the port; --no-browser suppresses the tab. Parsed by hand
# rather than with argparse because there are two options and one of them is
# positional.
ARGS = [a for a in sys.argv[1:] if not a.startswith("-")]
PORT = int(ARGS[0]) if ARGS else 8000

# start.bat wants a browser; a script driving the server does not, and having
# one appear over whatever the user is doing is worse than an inconvenience -
# it steals focus.
OPEN_BROWSER = "--no-browser" not in sys.argv
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
    # Deliberately NOT allow_reuse_address. On Windows that flag is
    # SO_REUSEADDR, which lets a second server bind a port another process is
    # already listening on: both appear to start, and which one answers a
    # request is not defined. Leaving it off makes the second instance fail
    # loudly instead, which is the whole point of the check below.
    allow_reuse_address = False


if __name__ == "__main__":
    os.chdir(ROOT)
    url = f"http://localhost:{PORT}"

    # Bind first, open the browser second. Opening it before the port is held
    # sends the browser to a server that may never start, and the connection
    # error it shows then looks nothing like the real problem of the port
    # already being in use.
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        sys.exit(f"\n  could not listen on {PORT}: {e}\n"
                 f"  Another server is probably already using it.\n")

    print(f"\n  Nuclear Option Mission Planner\n  {url}\n  Ctrl+C to stop.\n")
    if OPEN_BROWSER:
        webbrowser.open(url)
    try:
        with httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
