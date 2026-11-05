// duo-pause.yaml: wait until run-flow.sh's Duo watcher has captured the inner
// display and folded back. Each request long-polls up to 5 s on the server.
var deadline = Date.now() + 600000  // one unfold alone took 268 s (run 42068461077)
var state = 'unknown'
while (Date.now() < deadline) {
  try {
    var r = http.get(SYNC_URL + '/idle?wait=5')
    state = r.body
  } catch (e) {
    state = 'error: ' + e
  }
  if (state === 'idle') break
}
output.duoState = state
