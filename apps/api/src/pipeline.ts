/**
 * Data-pipeline status for the admin API: which datasets a country has,
 * when each was last loaded (data_loads), the pipeline's run history and
 * operator-requested runs (pipeline_jobs, see
 * db/migrations/20261011000000_pipeline_jobs.sql), and what the tile host
 * actually serves (manifest.json + one HEAD per file).
 *
 * Read-only except for queueing a run; the pipeline itself does the work.
 */
import { countryArchiveFile, countryDatasetFile } from '@open-vfr/shared/countryData'
import { pool } from './db.js'

/**
 * Jobs an operator may request. Ids are the `job` values the pipeline
 * writes to pipeline_jobs; a self-hosted pipeline that wants retry buttons
 * picks up queued rows with these ids. `when`: 'ready' = refresh of a
 * country whose data exists; 'pending' = first build of an enabled country
 * that has none yet (or whose build failed).
 */
export const PIPELINE_JOBS = {
  ofmx:      { label: 'Aviation data (AIRAC)', when: 'ready' },
  obstacles: { label: 'Obstacles',             when: 'ready' },
  landmarks: { label: 'Landmarks',             when: 'ready' },
  water:     { label: 'Water',                 when: 'ready' },
  aeroways:  { label: 'Aeroways',              when: 'ready' },
  landuse:   { label: 'Landuse',               when: 'ready' },
  basemap:   { label: 'Basemap',               when: 'ready' },
  build:     { label: 'Full build',            when: 'pending' },
} as const satisfies Record<string, { label: string; when: 'ready' | 'pending' }>

export type PipelineJob = keyof typeof PIPELINE_JOBS

export function isPipelineJob(v: unknown): v is PipelineJob {
  return typeof v === 'string' && Object.hasOwn(PIPELINE_JOBS, v)
}

/**
 * Every per-country dataset: its data_loads name, file, and the job that
 * refreshes it (null = only produced by a full build: terrain).
 */
const DATASETS: { id: string; file: (cc: string) => string; job: PipelineJob | null }[] = [
  { id: 'airspace',          file: cc => countryDatasetFile(cc, 'airspace'),         job: 'ofmx' },
  { id: 'aerodromes',        file: cc => countryDatasetFile(cc, 'aerodromes'),       job: 'ofmx' },
  { id: 'navaids',           file: cc => countryDatasetFile(cc, 'navaids'),          job: 'ofmx' },
  { id: 'waypoints',         file: cc => countryDatasetFile(cc, 'waypoints'),        job: 'ofmx' },
  { id: 'runways',           file: cc => countryDatasetFile(cc, 'runways'),          job: 'ofmx' },
  { id: 'runway_thresholds', file: cc => countryDatasetFile(cc, 'runwayThresholds'), job: 'ofmx' },
  { id: 'obstacles',         file: cc => countryDatasetFile(cc, 'obstacles'),        job: 'obstacles' },
  { id: 'landmarks',         file: cc => countryDatasetFile(cc, 'landmarks'),        job: 'landmarks' },
  { id: 'water',             file: cc => countryDatasetFile(cc, 'water'),            job: 'water' },
  { id: 'aeroways',          file: cc => countryDatasetFile(cc, 'aeroways'),         job: 'aeroways' },
  { id: 'landuse',           file: cc => countryArchiveFile(cc, 'landuse'),          job: 'landuse' },
  { id: 'basemap',           file: cc => countryArchiveFile(cc, 'basemap'),          job: 'basemap' },
  { id: 'hillshade',         file: cc => countryArchiveFile(cc, 'hillshade'),        job: null },
  { id: 'contours',          file: cc => countryArchiveFile(cc, 'contours'),         job: null },
]

// Where the apps download tiles from (manifest.json + per-country files).
// Unset = the file check is skipped.
const TILES_BASE_URL = (process.env['TILES_BASE_URL'] ?? '').trim().replace(/\/+$/, '')
const FETCH_TIMEOUT_MS = 6000
const SAFE_FILE = /^[a-z0-9][a-z0-9.-]{0,80}$/

interface CountrySummaryRow { country: string; airac: string | null; oldest: Date | null; datasets: number }
interface JobSummaryRow { country: string; active: number; failed: number }

/** Per-country data summary for the countries list. */
export async function countrySummaries(): Promise<Map<string, {
  airacCycle: string | null; oldestLoadAt: Date | null; datasetsLoaded: number; activeJobs: number; failedJobs: number
}>> {
  const [loads, jobs] = await Promise.all([
    pool.query<CountrySummaryRow>(`
      SELECT trim(country) AS country,
             min(airac_cycle) FILTER (WHERE airac_cycle IS NOT NULL) AS airac,
             min(loaded_at) AS oldest,
             count(*)::int AS datasets
      FROM data_loads GROUP BY 1`),
    pool.query<JobSummaryRow>(`
      SELECT country,
             count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active,
             count(*) FILTER (WHERE rn = 1 AND status = 'failed')::int     AS failed
      FROM (
        SELECT trim(country) AS country, status,
               row_number() OVER (PARTITION BY country, job ORDER BY requested_at DESC) AS rn
        FROM pipeline_jobs
      ) t
      GROUP BY 1`),
  ])
  const out = new Map<string, { airacCycle: string | null; oldestLoadAt: Date | null; datasetsLoaded: number; activeJobs: number; failedJobs: number }>()
  const get = (cc: string) => {
    let v = out.get(cc)
    if (!v) out.set(cc, v = { airacCycle: null, oldestLoadAt: null, datasetsLoaded: 0, activeJobs: 0, failedJobs: 0 })
    return v
  }
  for (const r of loads.rows) Object.assign(get(r.country), { airacCycle: r.airac, oldestLoadAt: r.oldest, datasetsLoaded: r.datasets })
  for (const r of jobs.rows) Object.assign(get(r.country), { activeJobs: r.active, failedJobs: r.failed })
  return out
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try { return await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' }) }
  finally { clearTimeout(t) }
}

interface ManifestJson {
  generated_at?: string
  files?: Record<string, { bytes?: number; sha256?: string }>
}

/**
 * What the tile host serves for one country: the manifest's entry per file
 * and a HEAD per file (size + Last-Modified as stored). Fixed base URL and
 * a strict file-name pattern, so nothing user-supplied reaches the URL.
 */
async function tileHostFiles(cc: string, expected: string[]) {
  if (!TILES_BASE_URL) return { configured: false as const }
  let manifest: ManifestJson | null = null
  let manifestError: string | null = null
  try {
    const res = await fetchWithTimeout(`${TILES_BASE_URL}/manifest.json`, {})
    if (res.ok) manifest = await res.json() as ManifestJson
    else manifestError = `manifest.json: HTTP ${res.status}`
  } catch (e) {
    manifestError = `manifest.json: ${(e as Error).name === 'AbortError' ? 'timeout' : 'unreachable'}`
  }

  const listed = Object.keys(manifest?.files ?? {}).filter(n => n.startsWith(`${cc}-`))
  const names = [...new Set([...expected, ...listed])].filter(n => SAFE_FILE.test(n)).sort()
  const stamp = Date.now()

  const items = await Promise.all(names.map(async name => {
    const m = manifest?.files?.[name]
    let status: number | null = null
    let bytes: number | null = null
    let lastModified: string | null = null
    let error: string | null = null
    try {
      // Unique query: skip any edge-cached copy, ask the bucket itself.
      // identity: a compressed answer has no Content-Length (stored size).
      const res = await fetchWithTimeout(`${TILES_BASE_URL}/${name}?admin-check=${stamp}`,
        { method: 'HEAD', headers: { 'accept-encoding': 'identity' } })
      status = res.status
      const len = res.headers.get('content-length')
      bytes = len !== null && /^\d+$/.test(len) ? Number(len) : null
      const lm = res.headers.get('last-modified')
      lastModified = lm ? new Date(lm).toISOString() : null
    } catch (e) {
      error = (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable'
    }
    return {
      name,
      expected: expected.includes(name),
      manifestBytes: typeof m?.bytes === 'number' ? m.bytes : null,
      manifestSha256: typeof m?.sha256 === 'string' ? m.sha256 : null,
      status, bytes, lastModified, error,
    }
  }))

  return {
    configured: true as const,
    baseUrl: TILES_BASE_URL,
    manifestGeneratedAt: manifest?.generated_at ?? null,
    manifestError,
    items,
  }
}

interface LoadRow { dataset: string; airac_cycle: string | null; loaded_at: Date; row_count: number }
interface RunRow {
  id: string; job: string; trigger: string; requested_by: string | null; requested_at: Date
  started_at: Date | null; finished_at: Date | null; status: string; message: string | null; log_tail: string | null
}

/** Everything the admin UI shows for one country. */
export async function countryPipelineDetail(cc: string, registry: { enabled: boolean; ready: boolean }) {
  const expected = DATASETS.map(d => d.file(cc))
  const [loads, runs, latest, files] = await Promise.all([
    pool.query<LoadRow>(
      `SELECT dataset, airac_cycle, loaded_at, row_count FROM data_loads WHERE country = $1`, [cc]),
    pool.query<RunRow>(`
      SELECT id, job, trigger, requested_by, requested_at, started_at, finished_at, status, message, NULL AS log_tail
      FROM pipeline_jobs WHERE country = $1 ORDER BY requested_at DESC LIMIT 30`, [cc]),
    // Latest run per job, with its log tail.
    pool.query<RunRow>(`
      SELECT DISTINCT ON (job) id, job, trigger, requested_by, requested_at, started_at, finished_at, status, message, log_tail
      FROM pipeline_jobs WHERE country = $1 ORDER BY job, requested_at DESC`, [cc]),
    tileHostFiles(cc, expected),
  ])

  const loadBy = new Map(loads.rows.map(r => [r.dataset, r]))
  const latestBy = new Map(latest.rows.map(r => [r.job, r]))
  const run = (r: RunRow) => ({
    id: Number(r.id), job: r.job, trigger: r.trigger, requestedBy: r.requested_by,
    requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status, message: r.message, logTail: r.log_tail,
  })

  return {
    datasets: DATASETS.map(d => {
      const l = loadBy.get(d.id)
      return {
        id: d.id, file: d.file(cc), job: d.job,
        airacCycle: l?.airac_cycle ?? null, loadedAt: l?.loaded_at ?? null, rowCount: l?.row_count ?? null,
      }
    }),
    jobs: (Object.keys(PIPELINE_JOBS) as PipelineJob[]).map(id => {
      const def = PIPELINE_JOBS[id]
      const last = latestBy.get(id)
      return {
        id, label: def.label,
        // Same rule as POST .../jobs: refreshes need built data, a build needs an enabled country without it.
        allowed: registry.enabled && (def.when === 'ready' ? registry.ready : !registry.ready),
        last: last ? run(last) : null,
      }
    }),
    runs: runs.rows.map(run),
    files,
  }
}

/** Queue a run. Returns the row id, or 'busy' if one is already queued/running. */
export async function queuePipelineJob(job: PipelineJob, cc: string, requestedBy: string): Promise<number | 'busy'> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO pipeline_jobs (job, country, requested_by) VALUES ($1, $2, $3) RETURNING id`,
      [job, cc, requestedBy],
    )
    return Number(rows[0]!.id)
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return 'busy'
    throw e
  }
}

/** Requests waiting for the pipeline, across all countries (abuse cap). */
export async function queuedCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pipeline_jobs WHERE status = 'queued'`)
  return rows[0]?.n ?? 0
}
