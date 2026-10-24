import { query } from '../db/pool.js';

export const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DIR_SHORT: Record<string, Direction> = {
  n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down',
  north: 'north', south: 'south', east: 'east', west: 'west', up: 'up', down: 'down',
};

export const OPPOSITE: Record<Direction, Direction> = {
  north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up',
};

export interface Exit {
  direction: Direction;
  to: string;
  hidden: boolean;
}

export type FeatureAction = string | { text: string; room?: string; event?: string; react?: boolean; scavenge?: string[] };

export interface Feature {
  name: string;
  keywords: string[];
  look: string;
  actions?: Record<string, FeatureAction>;
}

const FILLER = /^(at|the|a|an|on|in|into|to|with|behind|under|from|through|some|my|your|that|this)\s+/;

/** Lowercases and drops leading filler words: "at the curtain" becomes "curtain". */
export function cleanTarget(text: string): string {
  let t = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 5 && FILLER.test(t); i++) t = t.replace(FILLER, '');
  return t;
}

/** True when a cleaned phrase names something with this name and these keywords. */
function matches(phrase: string, name: string, keywords: string[]): boolean {
  if (!phrase) return false;
  const n = name.toLowerCase();
  const padded = ` ${phrase} `;
  return (
    n === phrase ||
    n.endsWith(` ${phrase}`) ||
    keywords.some((k) => k === phrase || padded.includes(` ${k} `) || (phrase.length >= 3 && k.startsWith(phrase)))
  );
}

const STOP = new Set(['of', 'and', 'with', 'on', 'in', 'the', 'a', 'an', 'at', 'to', 'some', 'that', 'this', 'it']);

function words(text: string): string[] {
  return cleanTarget(text)
    .split(' ')
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => w && !STOP.has(w));
}

/** Edit distance counting a swapped pair of letters as one typo ("sing" for "sign"). */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export interface Candidate<T> {
  name: string;
  keywords: string[];
  ref: T;
}

/**
 * Second chance matching, by context: scores everything in the room against the words typed,
 * forgiving partial words and small typos. Returns the single best match, or the names that tie.
 */
export function looseMatch<T>(phrase: string, cands: Candidate<T>[]): { ref: T; name: string } | { ambiguous: string[] } | null {
  const typed = words(phrase);
  if (!typed.length) return null;
  const scored = cands.map((c) => {
    const own = new Set([...words(c.name), ...c.keywords.flatMap((k) => words(k))]);
    let score = 0;
    for (const t of typed) {
      let best = 0;
      for (const o of own) {
        if (o === t) best = Math.max(best, 3);
        else if (t.length >= 3 && o.startsWith(t)) best = Math.max(best, 2);
        else if (o.length >= 4 && t.startsWith(o)) best = Math.max(best, 2);
        else if (t.length >= 4 && distance(t, o) <= 1) best = Math.max(best, 2);
        else if (t.length >= 6 && distance(t, o) <= 2) best = Math.max(best, 1);
      }
      score += best;
    }
    return { c, score };
  });
  const top = Math.max(0, ...scored.map((x) => x.score));
  if (!top) return null;
  const winners = scored.filter((x) => x.score === top);
  // One winner, or several copies of the same thing: either way it's obvious.
  if (new Set(winners.map((x) => x.c.name)).size === 1) return { ref: winners[0].c.ref, name: winners[0].c.name };
  return { ambiguous: [...new Set(winners.map((x) => x.c.name))] };
}

export interface Room {
  id: string;
  district: string;
  title: string;
  description: string;
  flags: string[];
  features: Feature[];
  exits: Exit[];
}

export interface Npc {
  id: string;
  roomId: string;
  name: string;
  kind: 'ai' | 'light' | 'scripted';
  card: {
    keywords: string[];
    short: string;
    look: string;
    listName?: string;
    scripted: string[];
    ambient?: string[];
    [k: string]: unknown;
  };
}

export class World {
  rooms = new Map<string, Room>();
  npcs = new Map<string, Npc>();
  startRoom = 'north_gate';

  async load(): Promise<void> {
    const rooms = await query('SELECT id, district, title, description, flags, features FROM rooms');
    const exits = await query('SELECT room_id, direction, to_room_id, hidden FROM exits');
    const npcs = await query('SELECT id, room_id, name, kind, card_json FROM npcs');

    this.rooms.clear();
    for (const r of rooms.rows) {
      this.rooms.set(r.id, { id: r.id, district: r.district, title: r.title, description: r.description, flags: r.flags, features: r.features ?? [], exits: [] });
      if (r.flags.includes('start')) this.startRoom = r.id;
    }
    for (const e of exits.rows) {
      this.rooms.get(e.room_id)?.exits.push({ direction: e.direction, to: e.to_room_id, hidden: e.hidden });
    }
    for (const room of this.rooms.values()) {
      room.exits.sort((a, b) => DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction));
    }
    this.npcs.clear();
    for (const n of npcs.rows) {
      this.npcs.set(n.id, { id: n.id, roomId: n.room_id, name: n.name, kind: n.kind, card: n.card_json });
    }
  }

  room(id: string): Room {
    return this.rooms.get(id) ?? this.rooms.get(this.startRoom)!;
  }

  npcsIn(roomId: string): Npc[] {
    return [...this.npcs.values()].filter((n) => n.roomId === roomId);
  }

  findFeature(roomId: string, words: string): Feature | undefined {
    const w = cleanTarget(words);
    return this.room(roomId).features.find((f) => matches(w, f.name, f.keywords));
  }

  /** Shortest walk between two rooms, as directions, using only exits players can see. */
  path(from: string, to: string): string[] | null {
    if (from === to) return [];
    const prev = new Map<string, { room: string; dir: string }>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of this.room(cur).exits) {
        if (e.hidden || seen.has(e.to)) continue;
        seen.add(e.to);
        prev.set(e.to, { room: cur, dir: e.direction });
        if (e.to === to) {
          const dirs: string[] = [];
          for (let at = to; at !== from; at = prev.get(at)!.room) dirs.unshift(prev.get(at)!.dir);
          return dirs;
        }
        queue.push(e.to);
      }
    }
    return null;
  }

  /** Finds an NPC in a room by name or keyword prefix. */
  findNpc(roomId: string, word: string): Npc | undefined {
    const w = cleanTarget(word);
    return this.npcsIn(roomId).find((n) => matches(w, n.card.listName ?? n.name, [n.name.toLowerCase(), ...n.card.keywords]));
  }
}
