/**
 * Shared PostgreSQL pool for the api (better-auth adapter + admin queries).
 * Connects as the least-privilege `api_app` role in production.
 */
import pg from 'pg'

const DB_URL = process.env['DATABASE_URL']
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for better-auth PostgreSQL adapter')
}

export const pool = new pg.Pool({ connectionString: DB_URL })
