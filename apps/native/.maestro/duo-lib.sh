# shellcheck shell=bash
# iPhone Duo fold helpers around duoctl (sourced by capture-ios.sh and
# run-flow.sh; DUOCTL_UDID names the simulator).
#
# The inner display sits a quarter turn from the cover: unfolded with the
# device upright it shows landscape, and `duoctl rotate portrait` gets the
# inner portrait by turning the DEVICE to landscape-left. Folding with the
# device still turned leaves the app rotated on the (portrait) cover, so
# Maestro's taps miss, and the cover sometimes never takes over. So unfold ->
# rotate -> shot, then turn the device back upright (inner "landscape" is
# device portrait, the first orientation duoctl tries) before folding.

# duo_step <label> <cmd...>: run a duoctl step, log how long it took.
duo_step() {
  local label="$1" t0 rc=0; shift
  t0=$(date +%s)
  "$@" >/dev/null || rc=$?
  echo "duo step '$label': $(( $(date +%s) - t0 ))s (exit $rc)"
  return "$rc"
}

# duo_inner_shot <png>: unfold, rotate the inner display to portrait, capture.
duo_inner_shot() {
  duo_step open duoctl open || return 1
  duo_step "rotate portrait" duoctl rotate portrait \
    || echo "::warning::inner display stayed landscape for $(basename "$1")"
  sleep 1
  duo_step screenshot duoctl screenshot "$1"
}

# duo_sync_server <raw> <done-dir>: start a localhost HTTP server for the
# flow's duo-pause.yaml. GET /idle answers "idle" once every takeScreenshot PNG
# under <raw> has a marker in <done-dir> (the watcher writes it after folding
# back), else "busy"; ?wait=N long-polls up to N s. Prints the PID, then the
# port, one per line.
duo_sync_server() {
  local portfile; portfile="$(mktemp)"
  python3 - "$1" "$2" "$portfile" <<'PY' >/dev/null 2>&1 &
import glob, http.server, os, sys, time, urllib.parse
raw, done, portfile = sys.argv[1:4]
def idle():
    shots = {os.path.basename(p)[:-4] for p in glob.glob(f"{raw}/**/takeScreenshot/*.png", recursive=True)}
    shots = {s for s in shots if not s.startswith("_")}
    return all(os.path.exists(os.path.join(done, s)) for s in shots)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        end = time.time() + min(float(q.get("wait", ["0"])[0]), 8)
        while not idle() and time.time() < end:
            time.sleep(0.25)
        body = ("idle" if idle() else "busy").encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
  local pid=$! i
  for i in $(seq 50); do [ -s "$portfile" ] && break; sleep 0.1; done
  echo "$pid"; cat "$portfile"; echo; rm -f "$portfile"
}

# duo_fold: device upright again, then fold onto the cover (retried once).
duo_fold() {
  if duoctl state 2>/dev/null | grep -q '"activeScreen": "inner"'; then
    duoctl rotate landscape >/dev/null || echo "::warning::could not turn the Duo back upright before folding"
  fi
  duoctl close && return 0
  echo "::warning::the cover did not take over after folding; retrying"
  duoctl state || true
  sleep 2
  duoctl close
}
