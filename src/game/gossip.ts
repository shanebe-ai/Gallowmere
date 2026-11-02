// The town talks about you (Milestone 5). Code writes down what a player did
// and who saw it, and works out who has heard by now: witnesses at once, then
// along the gossip chain one townsperson an hour. Dace hears every crime the
// moment it happens and Hook every theft; the light characters only hear what
// happened in the market. The AI is only told what its character has heard.

import { query } from '../db/pool.js';
import type { Game } from './game.js';
import type { Session } from './session.js';
import type { Npc } from './world.js';

/** Morda tells Hamo, Hamo tells Maud, Maud tells Osmund, Osmund tells Morda. */
export const CHAIN = ['morda', 'hamo', 'maud', 'osmund'];
export const HOUR = 60 * 60_000;
export const STORY_DAYS = 3;
const FULL_AI = new Set([...CHAIN, 'dace', 'hook', 'wenna']);

export type StoryKind = 'deed' | 'crime' | 'theft';

export interface Story {
  id: number;
  playerId: number;
  text: string;
  kind: StoryKind;
  roomId: string;
  district: string;
  witnesses: string[];
  at: number;
}

/** When a given townsperson hears a story, or null if they never will. */
export function heardAt(story: Story, npcId: string): number | null {
  if (story.witnesses.includes(npcId)) return story.at;
  if (npcId === 'dace' && (story.kind === 'crime' || story.kind === 'theft')) return story.at;
  if (npcId === 'hook' && story.kind === 'theft') return story.at;
  const i = CHAIN.indexOf(npcId);
  if (i >= 0) {
    const known = CHAIN.map((n, k) => (story.witnesses.includes(n) ? k : -1)).filter((k) => k >= 0);
    // Nobody on the chain saw it: it reaches the Drowned Rat within the hour, as everything does.
    const start = known.length ? known[0] : 0;
    const delay = known.length ? 0 : HOUR;
    const steps = (i - start + CHAIN.length) % CHAIN.length;
    return story.at + delay + steps * HOUR;
  }
  if (FULL_AI.has(npcId)) return null; // Wenna lives in Vesna; she hears nothing of Gallowmere's streets
  // Everyone else hears market talk, and only market talk.
  return story.district === 'market' ? story.at : null;
}

export class Gossip {
  constructor(private game: Game) {}

  /** Writes a story down, with the townsfolk who saw it with their own eyes. */
  async tell(playerId: number, text: string, kind: StoryKind, roomId: string, saw?: string[]): Promise<void> {
    try {
      const room = this.game.world.rooms.get(roomId);
      const near = new Set<string>([roomId, ...(room?.exits.map((e) => e.to) ?? [])]);
      const witnesses = saw ?? [...near].flatMap((r) => this.game.world.npcsIn(r).filter((n) => !n.mob).map((n) => n.id));
      await query(
        'INSERT INTO stories (player_id, text, kind, room_id, district, witnesses) VALUES ($1,$2,$3,$4,$5,$6)',
        [playerId, text, kind, roomId, room?.district ?? '', JSON.stringify([...new Set(witnesses)])],
      );
    } catch {
      /* a lost story is just gossip that never caught on */
    }
  }

  async storiesAbout(playerId: number, now = Date.now()): Promise<Story[]> {
    const { rows } = await query(
      `SELECT id, player_id, text, kind, room_id, district, witnesses, at FROM stories
       WHERE player_id = $1 AND at > now() - make_interval(days => $2) ORDER BY at DESC LIMIT 20`,
      [playerId, STORY_DAYS],
    );
    return rows.map((r) => ({
      id: Number(r.id), playerId: r.player_id, text: r.text, kind: r.kind, roomId: r.room_id, district: r.district,
      witnesses: r.witnesses ?? [], at: new Date(r.at).getTime(),
    })).filter((s) => s.at <= now);
  }

  /** What this townsperson has heard about this player, newest first. */
  async heardBy(npcId: string, playerId: number, now = Date.now()): Promise<Story[]> {
    return (await this.storiesAbout(playerId, now)).filter((s) => {
      const t = heardAt(s, npcId);
      return t !== null && t <= now;
    });
  }

  /** The two latest stories, for the character's prompt. */
  async noteFor(npc: Npc, player: { id: number; name: string }): Promise<string | undefined> {
    if (npc.mob || npc.card.mute) return undefined;
    const heard = (await this.heardBy(npc.id, player.id)).slice(0, 2);
    if (!heard.length) return undefined;
    return `What you have heard about ${player.name}: ${heard.map((s) => s.text).join('; ')}.`;
  }

  /** On arrival, a townsperson who has heard something new about you may say so, once per story. */
  async greet(s: Session): Promise<void> {
    const p = s.player!;
    for (const npc of this.game.world.npcsIn(p.roomId)) {
      if (npc.mob || npc.card.mute || npc.kind !== 'ai') continue;
      const story = (await this.heardBy(npc.id, p.id))[0];
      if (!story) continue;
      const { rowCount } = await query(
        'INSERT INTO story_greetings (story_id, npc_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [story.id, npc.id],
      );
      if (!rowCount) continue;
      void this.game.npcRespond(s, npc, `walks in. You have heard that ${story.text}. Mention it to them in one short line, in your own way`, 'event');
      return; // one greeting per arrival is plenty
    }
  }
}
