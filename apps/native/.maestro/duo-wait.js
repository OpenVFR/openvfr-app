// duo-pause.yaml: wait until run-flow.sh's Duo watcher has captured the inner
// display and folded back. Each request long-polls up to 5 s on the server, so
// the loop is throttled while the server answers; when it does not (watcher or
// server gone) give up after a few consecutive errors instead of spinning.
var deadline = Date.now() + 600000  // one unfold alone took 268 s (run 42068461077)
var state = 'unknown'
var errors = 0
while (Date.now() < deadline) {
  try {
    state = http.get(SYNC_URL + '/idle?wait=5').body
    errors = 0
  } catch (e) {
    state = 'error: ' + e
    if (++errors >= 5) break
  }
  // 'fold-failed' ends the wait too: the Duo is stuck unfolded.
  if (state === 'idle' || state === 'fold-failed') break
}
output.duoState = state
