#!/usr/bin/env node
// Drift guard: compares setting defaults / option lists in code with the
// tables in docs/guide/settings.md. Fails (exit 1) when they disagree, or
// when native gains a setting that is neither documented nor listed below.
//
//   node scripts/check-settings-docs.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const errors = [];
const fail = (m) => errors.push(m);

const doc = read('docs/guide/settings.md');
const nativeSrc = read('apps/native/src/hooks/useSettings.ts');
const webSrc = read('apps/web/src/db/useSettings.ts');

// ── code side ───────────────────────────────────────────────────────────────
const num = (s) => Number(String(s).replace(/_/g, ''));
const constant = (file, name) => {
  const m = read(file).match(new RegExp(`export const ${name}[^=]*=\\s*([^\\n]+)`));
  if (!m) throw new Error(`constant ${name} not found in ${file}`);
  return m[1].trim();
};
const objField = (file, name, field) => {
  const block = read(file).match(new RegExp(`export const ${name}[^=]*=\\s*\\{([^}]*)\\}`));
  const f = block?.[1].match(new RegExp(`${field}:\\s*([\\d._]+)`));
  if (!f) throw new Error(`${name}.${field} not found in ${file}`);
  return num(f[1]);
};
const list = (file, name) => {
  const m = read(file).match(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`list ${name} not found in ${file}`);
  return m[1].split(',').map((s) => num(s.trim())).filter((n) => !Number.isNaN(n));
};

const defaultsBlock = nativeSrc.match(/const DEFAULTS: AppSettings = \{([\s\S]*?)\n\}/)?.[1];
if (!defaultsBlock) throw new Error('native DEFAULTS block not found');
const native = {};
for (const line of defaultsBlock.split('\n')) {
  const m = line.match(/^\s*(\w+):\s*(.+?),?\s*(\/\/.*)?$/);
  if (m) native[m[1]] = m[2].replace(/,$/, '');
}
const nativeVal = (k) => {
  const v = native[k];
  if (v === undefined) throw new Error(`native DEFAULTS.${k} missing`);
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^[\d._]+$/.test(v)) return num(v);
  return v;
};

const PARK = 'packages/shared/src/parkTimeout.ts';
const MSA = 'packages/shared/src/msaMargins.ts';
const webDefault = (re, label) => {
  const m = webSrc.match(re);
  if (!m) throw new Error(`web default not found: ${label}`);
  return m[1];
};

// ── doc side ────────────────────────────────────────────────────────────────
// Returns the cells of the table row whose first cell equals `label`.
const row = (label) => {
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells[0] === label) return cells;
  }
  fail(`settings.md: no table row "${label}"`);
  return null;
};
const expectCell = (label, idx, expected, what) => {
  const cells = row(label);
  if (!cells) return;
  if (cells[idx] !== expected) fail(`settings.md "${label}" ${what}: doc says "${cells[idx]}", code says "${expected}"`);
};
const expectIncludes = (label, expected, what = 'text') => {
  const cells = row(label);
  if (cells && !cells.join(' | ').includes(expected)) fail(`settings.md "${label}" ${what}: expected to mention "${expected}"`);
};
const mins = (sec) => `${sec / 60} min`;
const ft = (n) => `${n.toLocaleString('en-US')} ft`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Units / theme / flying
expectCell('Theme', 2, cap(nativeVal('theme')), 'default');
expectCell('UI scale (native)', 2, nativeVal('uiScale').toFixed(1), 'default');
expectCell('Auto flying mode', 2, cap(nativeVal('autoFlyMode')), 'default');
expectCell('Auto flying mode', 2, cap(constant('packages/shared/src/autoFlyDetect.ts', 'AUTO_FLY_DEFAULT').replace(/['"]/g, '')), 'default (shared)');
expectCell('Auto zoom', 2, nativeVal('autoZoom') ? 'on' : 'off', 'default');
expectCell('Auto zoom', 2, webDefault(/useState<boolean>\((true|false)\)/, 'autoZoom') === 'true' ? 'on' : 'off', 'default (web)');
expectCell('Log simulated flights', 2, nativeVal('recordSimulatedFlights') ? 'on' : 'off', 'default');
expectCell('Trajectory mode', 2, nativeVal('trajectoryMode') === 'time' ? 'Time' : 'Distance', 'default');
expectCell('Trajectory mode', 2, webDefault(/useState<TrajectoryMode>\('(\w+)'\)/, 'trajectory') === 'time' ? 'Time' : 'Distance', 'default (web)');

const park = num(constant(PARK, 'PARK_TIMEOUT_DEFAULT'));
expectCell('Log split timeout', 2, mins(park), 'default');
const parkOpts = list(PARK, 'PARK_TIMEOUT_OPTIONS');
expectCell('Log split timeout', 1, 'Per leg, ' + parkOpts.filter((n) => n > 0).map((n) => n / 60).join(', ') + ' min', 'options');

// Airspace warnings
const lookOpts = list('apps/web/src/db/useSettings.ts', 'AIRSPACE_WARN_LOOKAHEAD_OPTIONS');
expectCell('Horizontal lookahead', 1, lookOpts.join(', ') + ' min', 'options');
expectCell('Horizontal lookahead', 2, mins(nativeVal('airspaceWarnLookaheadMin') * 60), 'default');
expectCell('Horizontal lookahead', 2, webDefault(/useState<AirspaceWarnLookahead>\((\d+)\)/, 'lookahead') + ' min', 'default (web)');
expectCell('Vertical buffer', 2, ft(nativeVal('airspaceWarnVerticalFt')), 'default');
expectCell('Vertical buffer', 2, ft(num(webDefault(/useState<number>\((\d+)\)/, 'vertical'))), 'default (web)');

// Alert banners
for (const [label, key] of [
  ['Obstacles ahead', 'alertObstacles'],
  ['Aerodrome nearby', 'alertAerodromes'],
  ['Airspace entered / left', 'alertAirspaceEvents'],
  ['Mute airspace warnings on planned course', 'alertSuppressOnCourse'],
]) expectCell(label, 1, nativeVal(key) ? 'on' : 'off', 'default');

// MSA
const abeam = objField(MSA, 'DEFAULT_MSA_MARGINS', 'abeamNm');
const terr = objField(MSA, 'DEFAULT_MSA_MARGINS', 'terrainClearanceFt');
const obst = objField(MSA, 'DEFAULT_MSA_MARGINS', 'obstacleClearanceFt');
const [aMin, aMax] = constant(MSA, 'MSA_ABEAM_RANGE_NM').match(/\d+/g).map(Number);
const [cMin, cMax] = constant(MSA, 'MSA_CLEARANCE_RANGE_FT').match(/\d+/g).map(Number);
expectCell('MSA abeam (corridor half-width)', 2, `${abeam} NM`, 'default');
expectCell('MSA abeam (corridor half-width)', 1, `${aMin} to ${aMax} NM`, 'range');
expectCell('Terrain clearance', 2, ft(terr), 'default');
expectCell('Terrain clearance', 1, `${cMin.toLocaleString('en-US')} to ${cMax.toLocaleString('en-US')} ft`, 'range');
expectCell('Obstacle clearance', 2, ft(obst), 'default');
expectCell('Obstacle clearance', 1, `${cMin.toLocaleString('en-US')} to ${cMax.toLocaleString('en-US')} ft`, 'range');

// Map
expectIncludes('Airspace ceiling', `Default ${ft(nativeVal('airspaceCeilingFt'))}`);
expectIncludes('Terrain colour reference altitude', `Default ${ft(nativeVal('terrainColorRefAltFt'))}`);
const tv = list('apps/web/src/db/useSettings.ts', 'TRAFFIC_VERT_FILTER_OPTIONS');
const tvDefault = num(webDefault(/useState<TrafficVertFilter>\((\d+)\)/, 'traffic filter'));
const tvText = tv.filter((n) => n > 0).map((n) => (n === tvDefault ? `${n.toLocaleString('en-US')} (default)` : n.toLocaleString('en-US'))).join(', ') + ' ft or all';
expectIncludes('Traffic vertical filter (web)', tvText, 'options/default');

// Sensors
expectCell('Internal barometer', 1, nativeVal('useInternalBarometer') ? 'on' : 'off', 'default');
expectCell('Show height above ground', 1, nativeVal('showAltitudeAgl') ? 'on' : 'off', 'default');
expectCell('Show QNH on the pressure altitude gauge', 1, nativeVal('showQnhOnPaltGauge') ? 'on' : 'off', 'default');
expectCell('Show local time', 1, nativeVal('showLocalTime') ? 'on' : 'off', 'default');
expectCell('QNH source and QNH', 1, `${nativeVal('qnhAuto') ? 'automatic' : 'manual'}, ${nativeVal('qnhHpa')} hPa`, 'default');
expectCell('BlueFly vario auto-connect', 1, nativeVal('varioAutoConnectId') === '' ? 'none' : nativeVal('varioAutoConnectId'), 'default');

// Units default (shared): doc says NM / kt
const units = read('packages/shared/src/units.ts').match(/DEFAULT_UNITS: Units = \{ distance: '(\w+)', speed: '(\w+)' \}/);
if (units) {
  expectCell('Distance', 2, units[1].toUpperCase(), 'default');
  expectCell('Speed', 2, units[2] === 'kts' ? 'kt' : units[2] === 'kmh' ? 'km/h' : units[2], 'default');
}

// Layer defaults: native LAYER_DEFAULTS that are off must be the ones named in map-and-layers.md.
const layerSrc = read('apps/native/src/components/MapDisplaySheet.tsx');
const layerBlock = layerSrc.match(/export const LAYER_DEFAULTS: LayerState = \{([\s\S]*?)\n\}/)?.[1] ?? '';
const offKeys = [...layerBlock.matchAll(/(\w+):\s*false/g)].map((m) => m[1]).sort();
const expectedOff = ['activity', 'contours', 'hillshade', 'satellite', 'terrainColor', 'traffic', 'wind'];
if (JSON.stringify(offKeys) !== JSON.stringify(expectedOff)) {
  fail(`native LAYER_DEFAULTS off-by-default layers changed (${offKeys.join(', ')}): update the "first open" paragraph in docs/guide/map-and-layers.md and expectedOff in scripts/check-settings-docs.mjs`);
}
const layersDoc = read('docs/guide/map-and-layers.md');
for (const phrase of ['Glider / Model areas, Hillshade, Contour', 'lines, Terrain colour, Air traffic and Wind']) {
  if (!layersDoc.replace(/\s+/g, ' ').includes(phrase.replace(/\s+/g, ' '))) fail(`map-and-layers.md: default-off layer list no longer says "${phrase}"`);
}

// ── new-setting guard ───────────────────────────────────────────────────────
// Every native setting key must be covered above or explicitly listed here.
const covered = new Set([
  'theme', 'uiScale', 'autoFlyMode', 'autoZoom', 'recordSimulatedFlights', 'trajectoryMode', 'parkTimeoutSec',
  'airspaceWarnLookaheadMin', 'airspaceWarnVerticalFt', 'alertObstacles', 'alertAerodromes', 'alertAirspaceEvents',
  'alertSuppressOnCourse', 'msaMargins', 'airspaceCeilingFt', 'terrainColorRefAltFt', 'useInternalBarometer',
  'showAltitudeAgl', 'showQnhOnPaltGauge', 'showLocalTime', 'qnhHpa', 'qnhAuto', 'varioAutoConnectId', 'units',
  // Documented in prose / not a user-facing default:
  'homeAirfield', 'selectedAircraftId', 'alertAirspaceLevels', 'trajectoryNm', 'baroPromptSeen',
]);
for (const k of Object.keys(native)) {
  if (!covered.has(k)) fail(`native setting "${k}" is not checked against docs/guide/settings.md: document it and add it to scripts/check-settings-docs.mjs`);
}

if (errors.length) {
  console.error('Settings docs drift:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('settings.md matches code defaults.');
