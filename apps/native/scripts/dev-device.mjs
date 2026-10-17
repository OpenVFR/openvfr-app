/**
 * One-command JS dev loop on an Android device (USB or wireless adb).
 *
 *   node scripts/dev-device.mjs [--local] [--clear] [--no-install]
 *
 * Steps: find an authorized device (clear error otherwise), wake it and wait
 * for unlock, `adb reverse` the dev ports, install the dev client only when it
 * is missing, start Metro, then deep-link the app straight to
 * http://localhost:8081. The dev client's server list relies on LAN discovery,
 * which never sees a USB/adb-reverse tunnel, so the deep link is what makes
 * the app connect without typing a URL.
 *
 *   --local        point the app at the local Docker stack (API :5200, tiles :5174)
 *   --clear        force-clear Metro's cache (slow first bundle). Done automatically
 *                  when switching between local and prod, because EXPO_PUBLIC_*
 *                  values are baked into the cached bundle.
 *   --no-install   never build/install the dev client
 *
 * Several devices attached: set ANDROID_SERIAL to pick one.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const args = new Set(process.argv.slice(2))
const local = args.has('--local')
const PORT = 8081
const REVERSE_PORTS = local ? [PORT, 5200, 5174, 5100] : [PORT]

const appJson = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo
const PACKAGE = appJson.android?.package
const SCHEME = `exp+${appJson.slug}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = msg => { console.error(`\n[dev-device] ${msg}\n`); process.exit(1) }
const log = msg => console.log(`[dev-device] ${msg}`)

let serial = process.env.ANDROID_SERIAL
const adb = (...a) => execFileSync('adb', serial ? ['-s', serial, ...a] : a, { encoding: 'utf8' }).trim()

// ── Device ──────────────────────────────────────────────────────────────────
function pickDevice() {
  let out
  try { out = execFileSync('adb', ['devices'], { encoding: 'utf8' }) }
  catch { fail('adb not found. Install Android platform-tools and put them on PATH.') }
  const rows = out.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(r => r[0])
  if (serial) {
    const row = rows.find(r => r[0] === serial)
    if (!row) fail(`ANDROID_SERIAL=${serial} is not connected.`)
    return row
  }
  if (rows.length === 0) fail('No device found. Plug it in (USB debugging on), or `adb pair` + `adb connect` for wireless.')
  const ready = rows.filter(r => r[1] === 'device')
  if (ready.length > 1) fail(`Several devices attached (${ready.map(r => r[0]).join(', ')}). Set ANDROID_SERIAL.`)
  return ready[0] ?? rows[0]
}

const [id, state] = pickDevice()
if (state === 'unauthorized') fail(`Device ${id} is unauthorized. Accept "Allow USB debugging?" on the phone (or revoke USB debugging authorizations and replug).`)
if (state !== 'device') fail(`Device ${id} is in state "${state}".`)
serial = id
log(`device ${id}`)

// ── Wake + unlock ───────────────────────────────────────────────────────────
const locked = () => /isKeyguardShowing=true|mDreamingLockscreen=true/.test(adb('shell', 'dumpsys', 'window'))
adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
try { adb('shell', 'wm', 'dismiss-keyguard') } catch { /* secure lock: handled below */ }
if (locked()) {
  log('phone is locked: unlock it (waiting up to 90 s)...')
  for (let i = 0; i < 45 && locked(); i++) await sleep(2000)
  if (locked()) fail('Phone still locked. Unlock it and run again.')
}

// ── Ports ───────────────────────────────────────────────────────────────────
for (const p of REVERSE_PORTS) adb('reverse', `tcp:${p}`, `tcp:${p}`)
log(`adb reverse: ${REVERSE_PORTS.join(', ')}`)

// ── Dev client ──────────────────────────────────────────────────────────────
const installed = PACKAGE && adb('shell', 'pm', 'list', 'packages', PACKAGE).includes(`package:${PACKAGE}`)
if (!installed && !args.has('--no-install')) {
  log(`${PACKAGE} not installed: building the dev client (several minutes the first time)...`)
  const res = spawn('npx', ['expo', 'run:android', '--no-bundler'], {
    stdio: 'inherit', shell: true, env: { ...process.env, ANDROID_SERIAL: serial },
  })
  const code = await new Promise(r => res.on('exit', r))
  if (code !== 0) fail('Dev client build failed.')
} else if (!installed) {
  fail(`${PACKAGE} is not installed and --no-install was given.`)
}

// ── Metro ───────────────────────────────────────────────────────────────────
const env = { ...process.env }
if (local) {
  env.EXPO_PUBLIC_API_BASE = 'http://localhost:5200'
  env.EXPO_PUBLIC_TILE_BASE = 'http://localhost:5174/tiles'
}
const modeFile = new URL('../.expo/dev-device-mode', import.meta.url)
const mode = local ? 'local' : 'prod'
const lastMode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : null
const clear = args.has('--clear') || lastMode !== mode
if (clear && lastMode !== mode) log(`target changed (${lastMode ?? 'first run'} -> ${mode}): clearing Metro cache`)
mkdirSync(new URL('../.expo/', import.meta.url), { recursive: true })
writeFileSync(modeFile, mode)
const metroArgs = ['expo', 'start', '--port', String(PORT), ...(clear ? ['--clear'] : [])]
const metro = spawn('npx', metroArgs, { stdio: 'inherit', shell: true, env })
const stop = () => { try { metro.kill() } catch { /* already gone */ } process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
metro.on('exit', code => process.exit(code ?? 0))

const up = async () => {
  try { return (await (await fetch(`http://localhost:${PORT}/status`)).text()).includes('running') }
  catch { return false }
}
for (let i = 0; i < 120 && !(await up()); i++) await sleep(1000)
if (!(await up())) fail('Metro did not come up on :' + PORT)

const url = `${SCHEME}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${PORT}`)}`
adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, PACKAGE)
log(`opened ${PACKAGE} -> localhost:${PORT} (first bundle can take a few minutes after --clear)`)
