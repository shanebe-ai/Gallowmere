import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface RoomSeed {
  id: string;
  district: string;
  title: string;
  description: string;
  flags?: string[];
  exits: Record<string, string>;
  hiddenExits?: string[];
}

interface NpcSeed {
  id: string;
  room: string;
  name: string;
  kind: 'ai' | 'scripted';
  card: Record<string, unknown>;
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(here, '..', 'world', file), 'utf8')) as T;
}

/** Applies the schema and upserts the world (rooms, exits, NPCs) from the JSON files. */
export async function migrate(client: pg.Pool | pg.PoolClient = pool): Promise<void> {
  const schema = readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await client.query(schema);

  const rooms = loadJson<RoomSeed[]>('rooms.json');
  const npcs = loadJson<NpcSeed[]>('npcs.json');

  await client.query('BEGIN');
  try {
    for (const r of rooms) {
      await client.query(
        `INSERT INTO rooms (id, district, title, description, flags) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET district=$2, title=$3, description=$4, flags=$5`,
        [r.id, r.district, r.title, r.description, r.flags ?? []],
      );
    }
    await client.query('DELETE FROM exits');
    for (const r of rooms) {
      for (const [dir, to] of Object.entries(r.exits)) {
        await client.query(
          'INSERT INTO exits (room_id, direction, to_room_id, hidden) VALUES ($1,$2,$3,$4)',
          [r.id, dir, to, (r.hiddenExits ?? []).includes(dir)],
        );
      }
    }
    for (const n of npcs) {
      await client.query(
        `INSERT INTO npcs (id, room_id, name, kind, card_json) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET room_id=$2, name=$3, kind=$4, card_json=$5`,
        [n.id, n.room, n.name, n.kind, JSON.stringify(n.card)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then(() => {
      console.log('Migration complete');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
