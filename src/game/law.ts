// The law inside the walls (Milestone 4): crimes, witnesses, heat, and
// the wanted list. Code decides what counts as a crime, who saw it, and
// how hot it runs; the AI only ever hears the rumour of it in talk.

import { query } from '../db/pool.js';
import { c } from './text.js';
import type { Game } from './game.js';
import type { Session } from './session.js';
import type { Npc } from './world.js';

/** Districts inside the town walls. The sewers run under the town but no
 *  watchman patrols them, and the wilds answer to nobody. The gate
 *  district sprawls across the wall itself, so the one road room past
 *  the gate is named on its own: the moor road is beyond the walls,
 *  whatever its district says. */
export const TOWN_DISTRICTS = new Set(['gate', 'market', 'tavern', 'docks', 'temple']);
const BEYOND_THE_WALL = new Set(['moor_road']);

/** The town watch of Gallowmere. Vesna's gate guard answers to Vesna. */
export const WATCH_IDS = new Set(['dace', 'sergeant']);

/** Street folk are townspeople for the law's purposes. A dog is not. */
const PERSON_KINDS = new Set(['drunk', 'ragpicker', 'preacher', 'cutpurse', 'ratcatcher', 'bruiser']);
export function isPersonKind(kind: string): boolean {
  return PERSON_KINDS.has(kind);
}

export type CrimeKind = 'attack' | 'theft' | 'kill' | 'murder' | 'guardkill';
const HEAT: Record<CrimeKind, number> = { attack: 10, theft: 15, kill: 25, murder: 40, guardkill: 60 };
const RUMOUR_HEAT = 2; // nobody saw it, but tongues wag

/** Heat halves every two hours, counted from when the crime was fresh. */
export const HALF_LIFE_MS = 2 * 60 * 60_000;
export function decayed(heat: number, atMs: number, now = Date.now()): number {
  return heat * Math.pow(0.5, Math.max(0, now - atMs) / HALF_LIFE_MS);
}

export function heatWords(heat: number): string {
  if (heat <= 0) return 'The watch has no quarrel with you.';
  if (heat < 15) return 'The watch has heard your name, nothing more.';
  if (heat < 40) return 'The watch is watching you.';
  if (heat < 80) return 'The watch wants you badly.';
  return 'The whole watch is out looking for you.';
}

export interface Witness {
  kind: 'guard' | 'npc' | 'player';
  id: string;
  name: string;
}

export interface CrimeRow {
  kind: CrimeKind;
  room_id: string;
  victim: string;
  witnesses: Witness[];
  seen: boolean;
  heat: number;
  at: string;
}

const VERBS: Record<CrimeKind, string> = {
  attack: 'Struck',
  theft: 'Stole from',
  kill: 'Killed',
  murder: 'Murdered',
  guardkill: 'Killed',
};

export class Law {
  constructor(private game: Game) {}

  insideWalls(roomId: string): boolean {
    const room = this.game.world.rooms.get(roomId);
    return !!room && TOWN_DISTRICTS.has(room.district) && !BEYOND_THE_WALL.has(roomId);
  }

  /** Who could say they saw it: a guard, a townsperson, or another player
   *  in the room or the next one over, and awake. The victim does not
   *  count; being hit is not the same as the town seeing it. */
  witnesses(roomId: string, criminalId: number, victimPlayerId?: number): Witness[] {
    const roomIds = new Set<string>([roomId]);
    const room = this.game.world.rooms.get(roomId);
    if (room) for (const e of room.exits) roomIds.add(e.to);
    const found = new Map<string, Witness>();
    const now = Date.now();
    for (const rid of roomIds) {
      for (const o of this.game.playersIn(rid)) {
        const pid = o.player!.id;
        if (pid === criminalId || pid === victimPlayerId) continue;
        const st = this.game.combat.players.get(pid);
        if (st && (st.outUntil > now || st.asleep)) continue;
        found.set(`player:${pid}`, { kind: 'player', id: String(pid), name: o.player!.name });
      }
      for (const n of this.game.world.npcsIn(rid)) {
        found.set(`npc:${n.id}`, { kind: WATCH_IDS.has(n.id) ? 'guard' : 'npc', id: n.id, name: n.name });
      }
    }
    return [...found.values()];
  }

  /** Writes a crime in the watch book. Never throws: a lost note in the
   *  book must not break the fight that caused it. An unwitnessed blow
   *  still runs a little heat on rumour; a body is always found in the
   *  end, so a killing runs its full heat seen or not. */
  async recordCrime(playerId: number, kind: CrimeKind, roomId: string, victim: string, victimPlayerId?: number): Promise<void> {
    try {
      if (!this.insideWalls(roomId)) return;
      const witnesses = this.witnesses(roomId, playerId, victimPlayerId);
      const seen = witnesses.length > 0;
      let heat = HEAT[kind];
      if (!seen && (kind === 'attack' || kind === 'theft')) heat = RUMOUR_HEAT;
      await query(
        'INSERT INTO crimes (player_id, kind, room_id, victim, witnesses, seen, heat) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [playerId, kind, roomId, victim, JSON.stringify(witnesses), seen, heat],
      );
    } catch {
      /* the watch book is not worth a broken fight */
    }
  }

  async heatOf(playerId: number, now = Date.now()): Promise<number> {
    const { rows } = await query('SELECT heat, at FROM crimes WHERE player_id = $1', [playerId]);
    let total = 0;
    for (const r of rows) total += decayed(Number(r.heat), new Date(r.at as string).getTime(), now);
    return total;
  }

  async recentCrimes(playerId: number, limit = 5): Promise<CrimeRow[]> {
    const { rows } = await query(
      'SELECT kind, room_id, victim, witnesses, seen, heat, at FROM crimes WHERE player_id = $1 ORDER BY at DESC LIMIT $2',
      [playerId, limit],
    );
    return rows as CrimeRow[];
  }

  /** What an NPC is told about the player they are talking to. Only real
   *  heat is worth a fact; below that the town has nothing to say. */
  async noteFor(npc: Npc, player: { id: number; name: string }): Promise<string | undefined> {
    const heat = await this.heatOf(player.id);
    if (heat < 15) return undefined;
    if (WATCH_IDS.has(npc.id)) {
      return `${player.name} is wanted by the watch (heat ${Math.round(heat)}). You know their face and their recent business in town.`;
    }
    return `Word around town is that ${player.name} is in trouble with the watch. Folk are talking about it.`;
  }

  /** wanted: your own heat, what the town remembers, and any bounty. */
  async wanted(s: Session): Promise<void> {
    const p = s.player!;
    const heat = await this.heatOf(p.id);
    s.out(c.title('You and the watch'));
    s.out(`Your heat: ${Math.round(heat)}. ${heatWords(heat)}`);
    s.out('No bounty on your head.');
    const rows = await this.recentCrimes(p.id);
    if (rows.length) {
      s.out('What the town remembers:');
      for (const r of rows) {
        const place = this.game.world.rooms.get(r.room_id)?.title ?? r.room_id;
        let tail: string;
        if (r.seen) {
          const names = r.witnesses.map((w) => w.name);
          tail = `seen by ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''}`;
        } else if (r.kind === 'kill' || r.kind === 'murder' || r.kind === 'guardkill') {
          tail = 'nobody saw it done, but the body told the tale';
        } else {
          tail = 'nobody saw it done';
        }
        s.out(`  ${VERBS[r.kind]} ${r.victim} at ${place}, ${tail}.`);
      }
    }
    s.out(c.dim('Old business fades with time. Lying low is a kind of apology.'));
  }
}
