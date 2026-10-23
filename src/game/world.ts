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

export type FeatureAction = string | { text: string; room?: string; event?: string; react?: boolean };

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
  kind: 'ai' | 'scripted';
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

  /** Finds an NPC in a room by name or keyword prefix. */
  findNpc(roomId: string, word: string): Npc | undefined {
    const w = cleanTarget(word);
    return this.npcsIn(roomId).find((n) => matches(w, n.card.listName ?? n.name, [n.name.toLowerCase(), ...n.card.keywords]));
  }
}
