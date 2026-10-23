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

export interface Feature {
  name: string;
  keywords: string[];
  look: string;
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
    const w = words.toLowerCase();
    if (!w) return undefined;
    return this.room(roomId).features.find(
      (f) => f.name.toLowerCase() === w || f.keywords.some((k) => k === w || (w.length >= 3 && k.startsWith(w))),
    );
  }

  /** Finds an NPC in a room by name or keyword prefix. */
  findNpc(roomId: string, word: string): Npc | undefined {
    const w = word.toLowerCase();
    if (!w) return undefined;
    return this.npcsIn(roomId).find(
      (n) => n.name.toLowerCase() === w || n.card.keywords.some((k) => k === w || (w.length >= 3 && k.startsWith(w))),
    );
  }
}
