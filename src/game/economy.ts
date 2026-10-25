import type pg from 'pg';
import { pool, query } from '../db/pool.js';
import { loadJson, type ItemSeed, type ShopSeed } from '../db/migrate.js';

export const PACK_LIMIT = 20;

export interface ItemAction {
  text: string;
  consume?: boolean;
}

export interface ItemTemplate {
  id: string;
  name: string;
  keywords: string[];
  kind: string;
  weight: number;
  price: number;
  look: string;
  actions: Record<string, string | ItemAction>;
  damage?: [number, number];
  armour?: number;
  heals?: number;
}

export interface Item {
  id: number;
  template: ItemTemplate;
}

export type Owner = { type: 'player' | 'room' | 'shop' | 'corpse' | 'chest'; id: string | number };

/** Static world economy: item templates and shop settings, loaded once. */
export class Catalog {
  templates = new Map<string, ItemTemplate>();
  shops = new Map<string, ShopSeed>();

  load(): void {
    this.templates.clear();
    for (const t of loadJson<ItemSeed[]>('items.json')) {
      this.templates.set(t.id, {
        id: t.id,
        name: t.name,
        keywords: t.keywords,
        kind: t.kind,
        weight: t.weight,
        price: t.price,
        look: t.look,
        actions: (t.actions ?? {}) as Record<string, string | ItemAction>,
        damage: t.damage,
        armour: t.armour,
        heals: t.heals,
      });
    }
    this.shops.clear();
    for (const s of loadJson<ShopSeed[]>('shops.json')) this.shops.set(s.npc, s);
  }

  template(id: string): ItemTemplate {
    const t = this.templates.get(id);
    if (!t) throw new Error(`Unknown item template ${id}`);
    return t;
  }
}

/** Runs fn in one database transaction. Everything that moves coin or items goes through here. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export class NotEnough extends Error {}

/** Changes a player's purse and bank, never below zero, and writes the ledger line. */
export async function moveCoin(
  c: pg.PoolClient,
  playerId: number,
  change: number,
  bankChange: number,
  reason: string,
): Promise<{ coin: number; bank: number }> {
  const { rows } = await c.query(
    `UPDATE players SET coin = coin + $2, bank_coin = bank_coin + $3
      WHERE id = $1 AND coin + $2 >= 0 AND bank_coin + $3 >= 0
      RETURNING coin, bank_coin`,
    [playerId, change, bankChange],
  );
  if (!rows.length) throw new NotEnough();
  await c.query(
    `INSERT INTO coin_ledger (player_id, change, bank_change, reason, balance_after, bank_after) VALUES ($1,$2,$3,$4,$5,$6)`,
    [playerId, change, bankChange, reason, rows[0].coin, rows[0].bank_coin],
  );
  return { coin: rows[0].coin, bank: rows[0].bank_coin };
}

/** Moves one item if it is still where we think it is. Returns false if someone got there first. */
export async function moveItem(c: pg.PoolClient, itemId: number, from: Owner, to: Owner): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE items SET owner_type = $4, owner_id = $5, created_at = now()
      WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
    [itemId, from.type, String(from.id), to.type, String(to.id)],
  );
  return rowCount === 1;
}

export async function deleteItem(c: pg.PoolClient, itemId: number, from: Owner): Promise<boolean> {
  const { rowCount } = await c.query('DELETE FROM items WHERE id = $1 AND owner_type = $2 AND owner_id = $3', [
    itemId,
    from.type,
    String(from.id),
  ]);
  return rowCount === 1;
}

export async function createItem(c: pg.PoolClient | null, templateId: string, to: Owner): Promise<number> {
  const run = c ?? pool;
  const { rows } = await run.query('INSERT INTO items (template_id, owner_type, owner_id) VALUES ($1,$2,$3) RETURNING id', [
    templateId,
    to.type,
    String(to.id),
  ]);
  return Number(rows[0].id);
}

export async function itemsOf(catalog: Catalog, owner: Owner): Promise<Item[]> {
  const { rows } = await query('SELECT id, template_id FROM items WHERE owner_type = $1 AND owner_id = $2 ORDER BY id', [
    owner.type,
    String(owner.id),
  ]);
  return rows
    .filter((r) => catalog.templates.has(r.template_id))
    .map((r) => ({ id: Number(r.id), template: catalog.template(r.template_id) }));
}

export function packWeight(items: Item[]): number {
  return items.reduce((w, i) => w + i.template.weight, 0);
}

/** "a coil of rope", or "3 x a coil of rope" style grouping for lists. */
export function groupNames(items: Item[]): string[] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.template.name, (counts.get(i.template.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} (x${n})` : name));
}

export async function balances(playerId: number): Promise<{ coin: number; bank: number }> {
  const { rows } = await query('SELECT coin, bank_coin FROM players WHERE id = $1', [playerId]);
  return { coin: rows[0]?.coin ?? 0, bank: rows[0]?.bank_coin ?? 0 };
}

// ------------------------------------------------------------------ standing

export async function getStanding(npcId: string, playerId: number): Promise<number> {
  const { rows } = await query('SELECT standing FROM npc_memory WHERE npc_id = $1 AND player_id = $2', [npcId, playerId]);
  return rows[0]?.standing ?? 0;
}

/** Nudges standing by delta, clamped to -5..5. With onceADay, only the first raise each day counts. */
export async function nudgeStanding(npcId: string, playerId: number, delta: number, onceADay = false): Promise<number> {
  if (onceADay) {
    const flag = `standing:${npcId}`;
    const today = new Date().toISOString().slice(0, 10);
    if ((await getFlag(playerId, flag))?.value === today) return getStanding(npcId, playerId);
    await setFlag(playerId, flag, today);
  }
  const { rows } = await query(
    `INSERT INTO npc_memory (npc_id, player_id, standing) VALUES ($1, $2, GREATEST(-5, LEAST(5, $3)))
     ON CONFLICT (npc_id, player_id) DO UPDATE SET standing = GREATEST(-5, LEAST(5, npc_memory.standing + $3))
     RETURNING standing`,
    [npcId, playerId, delta],
  );
  return rows[0].standing;
}

// ------------------------------------------------------------------ flags

export async function getFlag(playerId: number, flag: string): Promise<{ value: string; at: Date } | null> {
  const { rows } = await query('SELECT value, at FROM player_flags WHERE player_id = $1 AND flag = $2', [playerId, flag]);
  return rows[0] ? { value: rows[0].value, at: rows[0].at } : null;
}

export async function setFlag(playerId: number, flag: string, value: string): Promise<void> {
  await query(
    `INSERT INTO player_flags (player_id, flag, value, at) VALUES ($1,$2,$3,now())
     ON CONFLICT (player_id, flag) DO UPDATE SET value = $3, at = now()`,
    [playerId, flag, value],
  );
}

// ------------------------------------------------------------------ shops

export interface PriceRange {
  floor: number;
  ceiling: number;
}

/**
 * What a shop will sell for. Good standing pulls the asking price down, bad standing
 * pushes the floor up, always inside the shop's band.
 */
export function sellRange(base: number, band: [number, number], standing: number): PriceRange {
  const lo = base * band[0];
  const hi = base * band[1];
  const span = hi - lo;
  const ceiling = Math.max(1, Math.ceil(hi - (span * Math.max(0, standing)) / 10));
  const floor = Math.min(ceiling, Math.max(1, Math.ceil(lo + (span * Math.max(0, -standing)) / 10)));
  return { floor, ceiling };
}

/** What a shop will pay. Good standing raises the opening bid, bad standing lowers the most they'd pay. */
export function buyRange(base: number, band: [number, number], standing: number): PriceRange {
  const lo = base * band[0];
  const hi = base * band[1];
  const span = hi - lo;
  const ceiling = Math.max(1, Math.floor(hi - (span * Math.max(0, -standing)) / 10));
  const floor = Math.min(ceiling, Math.max(1, Math.floor(lo + (span * Math.max(0, standing)) / 10)));
  return { floor, ceiling };
}

/** Tops shop stock back up to its list and refills the buying purse once a day. */
export async function restockShops(catalog: Catalog): Promise<void> {
  for (const shop of catalog.shops.values()) {
    await tx(async (c) => {
      for (const [templateId, target] of Object.entries(shop.sells)) {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM items WHERE owner_type = 'shop' AND owner_id = $1 AND template_id = $2`,
          [shop.npc, templateId],
        );
        for (let n = rows[0].n; n < target; n++) await createItem(c, templateId, { type: 'shop', id: shop.npc });
      }
      await c.query(
        `INSERT INTO shops (npc_id, purse, purse_day) VALUES ($1, $2, CURRENT_DATE)
         ON CONFLICT (npc_id) DO UPDATE SET purse = $2, purse_day = CURRENT_DATE WHERE shops.purse_day < CURRENT_DATE`,
        [shop.npc, shop.purse],
      );
    });
  }
}

/** Takes coin from a shop's daily buying purse. False when it can't afford it today. */
export async function spendPurse(c: pg.PoolClient, npcId: string, amount: number): Promise<boolean> {
  const { rowCount } = await c.query('UPDATE shops SET purse = purse - $2 WHERE npc_id = $1 AND purse >= $2', [npcId, amount]);
  return rowCount === 1;
}

export async function purseOf(npcId: string): Promise<number> {
  const { rows } = await query('SELECT purse FROM shops WHERE npc_id = $1', [npcId]);
  return rows[0]?.purse ?? 0;
}

// ------------------------------------------------------------------ scavenging

export const SCAVENGE_COOLDOWN_MS = 60 * 60_000;

/** Claims a scavenging spot for this player. False when they searched it within the hour. */
export async function claimScavenge(playerId: number, spot: string): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO scavenges (player_id, spot, at) VALUES ($1, $2, now())
     ON CONFLICT (player_id, spot) DO UPDATE SET at = now()
     WHERE scavenges.at < now() - ($3 || ' milliseconds')::interval`,
    [playerId, spot, String(SCAVENGE_COOLDOWN_MS)],
  );
  return rowCount === 1;
}

/** Clears litter: items dropped in rooms more than two hours ago. */
export async function sweepRooms(): Promise<void> {
  await query(`DELETE FROM items WHERE owner_type = 'room' AND created_at < now() - interval '2 hours'`);
}
