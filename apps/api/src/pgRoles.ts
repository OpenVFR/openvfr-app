/**
 * The PostgreSQL roles the api names in the tokens it mints. They are created by the migrations
 * (db/migrations) and exist twice in the system: here and there. pgRoles.test.ts keeps them in step.
 *
 * Every role carries the `openvfr_` prefix: roles belong to the whole Postgres server, and a plain
 * `anon` / `authenticator` can already exist on a server shared with another project.
 */

/** The role PostgREST switches into (SET ROLE) for a request with a valid token. */
export const AUTHENTICATED_ROLE = 'openvfr_authenticated'

/** The slice of a pg pool the check needs (so a test can pass a fake). */
export interface RoleCheckPool {
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>
}

/**
 * Fail fast on a database that predates the `openvfr_` role prefix. Without this the api starts normally, signs
 * tokens for a role PostgREST cannot switch into, and every sync request is refused: a silent outage.
 *
 * Only a role that is definitely missing is fatal; a database that cannot be reached yet (the api may start before
 * it) is retried by the pool later and only warned about here. Returns whether it ended the process.
 */
export async function assertAuthenticatedRoleExists(
  pool: RoleCheckPool,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<boolean> {
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [AUTHENTICATED_ROLE])
    if (rowCount) return false
    // console.error on purpose: stderr from this container pages the operator.
    console.error(
      `FATAL: the database has no role "${AUTHENTICATED_ROLE}", which PostgREST switches into for signed-in users. ` +
      'This database predates the openvfr_ role prefix: rename its roles once (docs/self-hosting.md, "Upgrading a database ' +
      'created before the openvfr_ role prefix") or recreate it, then restart the api.',
    )
    exit(1)
    return true
  } catch (err) {
    console.warn(`WARNING: could not check for the ${AUTHENTICATED_ROLE} role (${err instanceof Error ? err.message : String(err)})`)
    return false
  }
}
