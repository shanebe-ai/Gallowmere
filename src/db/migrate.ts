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
  features?: Array<{ name: string; keywords: string[]; look: string }>;
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

export interface ItemSeed {
  id: string;
  name: string;
  keywords: string[];
  kind: string;
  weight: number;
  price: number;
  look: string;
  actions?: Record<string, unknown>;
}

export interface ShopSeed {
  npc: string;
  room: string;
  haggle: boolean;
  sells: Record<string, number>;
  buys: string[];
  purse: number;
  sellBand: [number, number];
  buyBand: [number, number];
}

export function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(here, '..', 'world', file), 'utf8')) as T;
}

/** Applies the schema and upserts the world (rooms, exits, NPCs) from the JSON files. */
export async function migrate(client: pg.Pool | pg.PoolClient = pool): Promise<void> {
  const schema = readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await client.query(schema);

  const rooms = loadJson<RoomSeed[]>('rooms.json');
  const npcs = loadJson<NpcSeed[]>('npcs.json');
  const items = loadJson<ItemSeed[]>('items.json');
  const shops = loadJson<ShopSeed[]>('shops.json');

  await client.query('BEGIN');
  try {
    for (const r of rooms) {
      await client.query(
        `INSERT INTO rooms (id, district, title, description, flags, features) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET district=$2, title=$3, description=$4, flags=$5, features=$6`,
        [r.id, r.district, r.title, r.description, r.flags ?? [], JSON.stringify(r.features ?? [])],
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
    // NPCs removed from the JSON leave the world (their memories go with them).
    await client.query('DELETE FROM npcs WHERE NOT (id = ANY($1))', [npcs.map((n) => n.id)]);
    for (const it of items) {
      await client.query(
        `INSERT INTO item_templates (id, name, keywords, kind, weight, price, card_json) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET name=$2, keywords=$3, kind=$4, weight=$5, price=$6, card_json=$7`,
        [it.id, it.name, it.keywords, it.kind, it.weight, it.price, JSON.stringify({ look: it.look, actions: it.actions ?? {} })],
      );
    }
    for (const sh of shops) {
      await client.query(
        `INSERT INTO shops (npc_id, purse) VALUES ($1,$2) ON CONFLICT (npc_id) DO NOTHING`,
        [sh.npc, sh.purse],
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
