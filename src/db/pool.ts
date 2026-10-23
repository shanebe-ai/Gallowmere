import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ ...config.db, max: 10 });

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}
