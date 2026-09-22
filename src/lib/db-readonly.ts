import { Pool, PoolClient, QueryResultRow } from 'pg';
import { env } from '../config/env.js';

/**
 * Normalizes PostgreSQL connection string by handling bracketed passwords
 * and properly encoding special URI characters.
 */
function normalizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      let pw = decodeURIComponent(parsed.password);
      if (pw.startsWith('[') && pw.endsWith(']')) {
        pw = pw.slice(1, -1);
      }
      parsed.password = encodeURIComponent(pw);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

let poolInstance: Pool | null = null;

export function getReadonlyPool(): Pool {
  if (poolInstance) {
    return poolInstance;
  }

  const connectionString = env.READONLY_DATABASE_URL
    ? normalizeDatabaseUrl(env.READONLY_DATABASE_URL)
    : undefined;

  if (!connectionString) {
    throw new Error('READONLY_DATABASE_URL is not configured in environment variables');
  }

  poolInstance = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  poolInstance.on('error', (err) => {
    console.error('[DB Readonly Pool] Unexpected error on idle client:', err);
  });

  return poolInstance;
}

/**
 * Executes a strictly read-only SQL query against the database with
 * session-level read-only mode and 3000ms statement timeout.
 */
export async function executeReadonlyQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getReadonlyPool();
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    // Enforce read-only transaction and strict 3s statement timeout on session
    await client.query(
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SET statement_timeout = 3000;'
    );
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    if (client) {
      client.release();
    }
  }
}
