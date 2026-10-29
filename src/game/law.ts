// The law inside the walls (Milestone 4): crimes, witnesses, heat, and
// the wanted list. Code decides what counts as a crime, who saw it, and
// how hot it runs; the AI only ever hears the rumour of it in talk.

import { query } from '../db/pool.js';
import { moveCoin, NotEnough, tx, getFlag, setFlag } from './economy.js';
import { c, capitalize, sanitize } from './text.js';
import { isFlagged } from './filter.js';
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

/** Heat at which the watch comes for you: "the watch wants you badly". */
export const ARREST_HEAT = 40;
export const WATCH_HOUSE = 'watch_house';
export const CELLS = 'lockup';
/** What a jailed player may still do: talk, look about, and pay their way out. */
const IN_CELL_OK = new Set(['l', 'look', 'examine', 'x', 'say', 'emote', 'emotes', 'i', 'inv', 'inventory', 'who', 'help', 'score', 'sc',
  'health', 'hp', 'wanted', 'heat', 'law', 'pay', 'fine', 'sentence', 'quit', 'exit', 'logout', 'alias', 'journal']);

/** Coin the watch pays for bringing down a wanted player, by their heat. */
export const BOUNTY_CAP = 25;
export const BOUNTY_DAILY_PURSE = 100;
export function bountyFor(heat: number): number {
  return heat >= ARREST_HEAT ? Math.min(BOUNTY_CAP, Math.round(heat / 4)) : 0;
}
export const NOTICEBOARD_ROOM = 'market_square';
export const NOTE_MAX = 120;

/** Minutes in the cells and the fine to leave early, both set by heat at the arrest. */
export function sentenceFor(heat: number): { minutes: number; fine: number } {
  const minutes = Math.max(2, Math.min(15, Math.round(2 + heat / 8)));
  const fine = Math.max(3, Math.round(3 + heat / 5));
  return { minutes, fine };
}

function minutesLeft(until: number, now = Date.now()): string {
  const m = Math.max(1, Math.ceil((until - now) / 60_000));
  return m === 1 ? 'a minute' : `${m} minutes`;
}

interface Patrol {
  playerId: number;
  npc: Npc;
  /** When it walked into the wanted player's room: the arrest comes on the next tick, a last chance to run. */
  caughtUpAt: number;
}

export class Law {
  /** Who is in the cells: release time and the fine to leave early. */
  jailed = new Map<number, { until: number; fine: number }>();
  /** One watch patrol per wanted player, walking towards them. */
  patrols = new Map<number, Patrol>();
  private timer: ReturnType<typeof setInterval> | null = null;

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
    const { rows } = await query('SELECT heat, at FROM crimes WHERE player_id = $1 AND NOT cleared', [playerId]);
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
    const jail = this.jailed.get(p.id);
    if (jail) s.out(c.error(`You are in the cells for ${minutesLeft(jail.until)} more, or until you pay your ${jail.fine} coin fine.`));
    else if (heat >= ARREST_HEAT) s.out(c.error('The watch is out looking for you. Lie low outside the walls, or give yourself up: surrender.'));
    const bounty = bountyFor(heat);
    s.out(bounty ? c.error(`There is a ${bounty} coin bounty on your head, posted on the noticeboard in the market.`) : 'No bounty on your head.');
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

  // ---------------------------------------------------------------- the watch (step 3)

  start(ms = 6000): void {
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('watch tick failed:', e)), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isJailed(playerId: number): boolean {
    return this.jailed.has(playerId);
  }

  /** In the cells, most commands meet a locked cage door. */
  blocks(s: Session, verb: string): boolean {
    const jail = this.jailed.get(s.player!.id);
    if (!jail || IN_CELL_OK.has(verb)) return false;
    s.out(c.error(`The cage door is locked. ${capitalize(minutesLeft(jail.until))} to go, or pay fine to buy your way out (${jail.fine} coin).`));
    return true;
  }

  /** On login, before the room is shown: a sentence still running puts you back in the cells;
   *  one that ran out while you were away lets you out at the watch house. */
  async loadJail(s: Session): Promise<void> {
    const p = s.player!;
    const flag = await getFlag(p.id, 'jail');
    if (!flag?.value) return;
    const [until, fine] = flag.value.split(':').map(Number);
    let room = p.roomId;
    if (until <= Date.now()) {
      await this.clearRecord(p.id);
      if (room === CELLS) room = WATCH_HOUSE;
    } else {
      this.jailed.set(p.id, { until, fine });
      room = CELLS;
    }
    if (room !== p.roomId) {
      p.roomId = room;
      await query('UPDATE players SET room_id=$2 WHERE id=$1', [p.id, room]);
    }
  }

  /** One beat of the watch: patrols set out, walk, catch up and arrest; sentences run out. */
  async tick(now = Date.now()): Promise<void> {
    for (const [id, jail] of this.jailed) if (jail.until <= now) await this.release(id, 'served');
    for (const s of this.game.sessions) {
      const p = s.player;
      if (!p || s.state !== 'playing' || this.jailed.has(p.id) || this.patrols.has(p.id)) continue;
      if (!this.insideWalls(p.roomId)) continue;
      const heat = await this.heatOf(p.id, now);
      if (heat < ARREST_HEAT) continue;
      this.sendPatrol(s);
    }
    for (const patrol of [...this.patrols.values()]) await this.walkPatrol(patrol, now);
  }

  private sendPatrol(s: Session): void {
    const p = s.player!;
    const npc: Npc = {
      id: `patrol_${p.id}`,
      roomId: WATCH_HOUSE,
      name: 'a watch patrol',
      kind: 'light',
      card: {
        keywords: ['patrol', 'watch', 'watchmen', 'watchman'],
        listName: 'a watch patrol',
        short: 'Two watchmen with cudgels and a sergeant with a lantern, looking for someone.',
        look: `Two tired watchmen in muddy tabards and a sergeant with a lantern and a writ. The name on the writ is ${p.name}.`,
        scripted: ['We are looking for someone. Move along.'],
        mute: true,
      },
    };
    this.game.world.npcs.set(npc.id, npc);
    this.patrols.set(p.id, { playerId: p.id, npc, caughtUpAt: 0 });
    s.out(c.error('Somewhere behind you a watch whistle shrills, then another. The watch is coming for you.'));
    this.game.toRoom(WATCH_HOUSE, c.dim(`A sergeant snatches a writ off the desk and two watchmen follow him out.`));
  }

  private endPatrol(patrol: Patrol, why?: string): void {
    if (why) this.game.toRoom(patrol.npc.roomId, c.dim(why));
    this.game.world.npcs.delete(patrol.npc.id);
    this.patrols.delete(patrol.playerId);
  }

  private async walkPatrol(patrol: Patrol, now: number): Promise<void> {
    const s = this.game.sessionOf(patrol.playerId);
    const p = s?.player;
    if (!s || !p || s.state !== 'playing') return this.endPatrol(patrol, 'The watch patrol mutters about a wasted night and heads back to the watch house.');
    if (this.jailed.has(p.id)) return this.endPatrol(patrol);
    if (!this.insideWalls(p.roomId)) return this.endPatrol(patrol, 'The watch patrol stops at the edge of town. Beyond the walls is not their business. They turn back.');
    const heat = await this.heatOf(p.id, now);
    if (heat < ARREST_HEAT) return this.endPatrol(patrol, 'The sergeant reads the writ again, shrugs, and the patrol turns for home.');
    if (patrol.npc.roomId === p.roomId) {
      if (patrol.caughtUpAt) return this.arrest(s, heat, 'caught');
      patrol.caughtUpAt = now;
      s.out(c.error(`The watch patrol blocks your way. "${p.name}? You're coming with us." Run, or surrender.`));
      return;
    }
    patrol.caughtUpAt = 0;
    const path = this.game.world.path(patrol.npc.roomId, p.roomId);
    if (!path?.length) return this.endPatrol(patrol);
    const room = this.game.world.room(patrol.npc.roomId);
    const exit = room.exits.find((e) => e.direction === path[0]);
    if (!exit) return this.endPatrol(patrol);
    this.game.toRoom(room.id, c.dim(`The watch patrol tramps off ${exit.direction}, lantern swinging.`));
    patrol.npc.roomId = exit.to;
    this.game.toRoom(exit.to, c.error('A watch patrol comes in, lantern raised, looking at every face.'));
    if (exit.to === p.roomId) {
      patrol.caughtUpAt = now;
      s.out(c.error(`The patrol's lantern finds your face. "${p.name}! Stand where you are, in the name of the watch." Run, or surrender.`));
    }
  }

  /** surrender: give yourself up to a patrol or at the watch house. A shorter stay for saving them the walk. */
  async surrender(s: Session): Promise<void> {
    const p = s.player!;
    if (this.jailed.has(p.id)) return s.out("You're already in the cells.");
    const heat = await this.heatOf(p.id);
    const patrol = this.patrols.get(p.id);
    const here = (patrol && patrol.npc.roomId === p.roomId) || p.roomId === WATCH_HOUSE;
    if (heat < 15) return s.out('Nobody wants you for anything. The watch would only laugh.');
    if (!here) return s.out('There is nobody here to surrender to. The watch house is by the north gate.');
    return this.arrest(s, heat * 0.75, 'surrendered');
  }

  async arrest(s: Session, heat: number, how: 'caught' | 'surrendered'): Promise<void> {
    const p = s.player!;
    const { minutes, fine } = sentenceFor(heat);
    const until = Date.now() + minutes * 60_000;
    this.game.stopTravel(s);
    this.game.combat.endFightsWith(`p:${p.id}`);
    const patrol = this.patrols.get(p.id);
    if (patrol) this.endPatrol(patrol);
    this.jailed.set(p.id, { until, fine });
    await setFlag(p.id, 'jail', `${until}:${fine}`);
    if (how === 'caught') {
      s.out(c.error('Hands grab your arms. A cudgel taps your knee, not hard, just to make the point. The watch marches you to the lockup.'));
      this.game.toRoom(p.roomId, c.dim(`The watch seizes ${p.name} and marches them off towards the gate.`), s);
    } else {
      s.out(c.system('You hold out your wrists. The sergeant looks almost grateful, and walks you down to the lockup himself.'));
      this.game.toRoom(p.roomId, c.dim(`${p.name} gives themselves up to the watch.`), s);
    }
    await this.place(s, CELLS);
    s.out(c.system(`The cage door clangs shut. ${capitalize(minutesLeft(until))} in the cells, or pay fine (${fine} coin). A friend could bail you out from the watch house.`));
  }

  /** Lets a prisoner out: time served, a fine paid, or bail. Their record is wiped clean either way. */
  async release(playerId: number, how: 'served' | 'fine' | 'bail', by?: string): Promise<void> {
    this.jailed.delete(playerId);
    await this.clearRecord(playerId);
    const s = this.game.sessionOf(playerId);
    if (!s?.player) return;
    const words = {
      served: 'A watchman rattles the key in the lock. "Time served. Out, and don\'t come back."',
      fine: 'The sergeant counts your coin twice, then unlocks the cage. "Paid in full. Off you go."',
      bail: `The sergeant unlocks the cage. "${by ?? 'Someone'} has paid your bail. Thank them, not me."`,
    }[how];
    s.out(c.system(words));
    await this.place(s, WATCH_HOUSE);
  }

  private async clearRecord(playerId: number): Promise<void> {
    await query('UPDATE crimes SET cleared = true WHERE player_id = $1', [playerId]);
    await setFlag(playerId, 'jail', '');
  }

  /** Moves a player, with the room told, and shows them where they are. */
  private async place(s: Session, roomId: string): Promise<void> {
    const p = s.player!;
    if (p.roomId !== roomId) this.game.toRoom(p.roomId, c.dim(`${p.name} is led away.`), s);
    p.roomId = roomId;
    await query('UPDATE players SET room_id=$2 WHERE id=$1', [p.id, roomId]);
    this.game.toRoom(roomId, c.dim(roomId === CELLS ? `The watch shoves ${p.name} into a cage.` : `${p.name} comes up the stairs from the lockup, blinking.`), s);
    await this.game.look(s, '');
    this.game.updateStatus(s);
  }

  /** pay fine: buy your way out of the cells. */
  async payFine(s: Session): Promise<void> {
    const p = s.player!;
    const jail = this.jailed.get(p.id);
    if (!jail) return s.out('You owe the watch nothing.');
    try {
      await tx((cl) => moveCoin(cl, p.id, -jail.fine, 0, 'fine paid to the watch'));
    } catch (e) {
      if (!(e instanceof NotEnough)) throw e;
      return s.out(`The fine is ${jail.fine} coin and you haven't got it. Wait it out, or hope someone pays your bail.`);
    }
    await this.release(p.id, 'fine');
  }

  /** bail <name>: pay someone's fine from the watch house or the lockup. */
  async bail(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const want = rest.trim().toLowerCase();
    if (!want) return s.out('Bail whom? bail <name>, in the watch house or the lockup.');
    if (p.roomId !== WATCH_HOUSE && p.roomId !== CELLS) return s.out('Bail is paid to the duty sergeant, in the watch house by the north gate.');
    const target = [...this.jailed.keys()].map((id) => this.game.sessionOf(id)).find((o) => o?.player && o.player.name.toLowerCase().startsWith(want));
    if (!target?.player) return s.out("There's nobody in the cells by that name. Not right now, anyway.");
    if (target.player.id === p.id) return s.out("You can't bail yourself. That's what pay fine is for.");
    const jail = this.jailed.get(target.player.id)!;
    try {
      await tx(async (cl) => {
        await moveCoin(cl, p.id, -jail.fine, 0, `bail paid for ${target.player!.name}`);
      });
    } catch (e) {
      if (!(e instanceof NotEnough)) throw e;
      return s.out(`Bail for ${target.player.name} is ${jail.fine} coin. You haven't got that much.`);
    }
    s.out(c.system(`You count ${jail.fine} coin onto the sergeant's desk. He writes it in his ledger with a sigh.`));
    this.game.updateStatus(s);
    await this.release(target.player.id, 'bail', p.name);
  }

  /** sentence: how long is left. */
  sentence(s: Session): void {
    const jail = this.jailed.get(s.player!.id);
    if (!jail) return s.out("You're free. Keep it that way.");
    s.out(`${capitalize(minutesLeft(jail.until))} left in the cells, or pay fine (${jail.fine} coin).`);
  }

  // ---------------------------------------------------------------- the noticeboard and bounties (step 4)

  async isWanted(playerId: number): Promise<boolean> {
    return (await this.heatOf(playerId)) >= ARREST_HEAT;
  }

  /** Everyone the watch wants right now, hottest first, with their bounty. */
  async wantedList(now = Date.now()): Promise<Array<{ id: number; name: string; heat: number; bounty: number }>> {
    const { rows } = await query(
      `SELECT c.player_id, p.name, c.heat, c.at FROM crimes c JOIN players p ON p.id = c.player_id WHERE NOT c.cleared`,
    );
    const heat = new Map<number, { name: string; heat: number }>();
    for (const r of rows) {
      const e = heat.get(r.player_id) ?? { name: r.name as string, heat: 0 };
      e.heat += decayed(Number(r.heat), new Date(r.at as string).getTime(), now);
      heat.set(r.player_id, e);
    }
    return [...heat.entries()]
      .filter(([, e]) => e.heat >= ARREST_HEAT)
      .map(([id, e]) => ({ id, name: e.name, heat: e.heat, bounty: bountyFor(e.heat) }))
      .sort((a, b) => b.heat - a.heat);
  }

  /**
   * A wanted player brought down by another: the watch pays the bounty, from a purse that
   * only holds so much a day, and the name comes off the board. Returns the coin paid, or 0.
   */
  async claimBounty(hunterId: number, quarryId: number): Promise<number> {
    if (hunterId === quarryId) return 0;
    const heat = await this.heatOf(quarryId);
    const bounty = bountyFor(heat);
    if (!bounty) return 0;
    const { rows } = await query(
      `SELECT COALESCE(SUM(change), 0) AS paid FROM coin_ledger WHERE reason LIKE 'bounty for %' AND created_at > date_trunc('day', now())`,
    );
    const left = BOUNTY_DAILY_PURSE - Number(rows[0].paid);
    const pay = Math.min(bounty, Math.max(0, left));
    const { rows: names } = await query('SELECT name FROM players WHERE id = $1', [quarryId]);
    const name = (names[0]?.name as string) ?? 'someone';
    if (pay > 0) await tx((cl) => moveCoin(cl, hunterId, pay, 0, `bounty for ${name}, paid by the watch`));
    await this.clearRecord(quarryId);
    const hunter = this.game.sessionOf(hunterId);
    hunter?.out(
      pay > 0
        ? c.system(`The watch will want to hear of this. A runner finds you soon after: ${pay} coin, the bounty on ${name}.`)
        : c.system(`The watch is glad of it, but the bounty purse is empty for today. ${name}'s name comes off the board all the same.`),
    );
    this.game.sessionOf(quarryId)?.out(c.dim('Your name comes off the noticeboard. Justice, of a sort, has been done.'));
    await this.game.town.rumour(hunterId, `${hunter?.player?.name ?? 'Someone'} brought down ${name}, who was wanted by the watch`);
    if (hunter) this.game.updateStatus(hunter);
    return pay;
  }

  /** read notices: what's posted in the market. */
  async noticeboard(s: Session): Promise<void> {
    if (s.player!.roomId !== NOTICEBOARD_ROOM) return s.out('The noticeboard is in the market square.');
    s.out(c.title('The noticeboard'));
    const wanted = await this.wantedList();
    s.out(c.label('WANTED by the watch'));
    if (!wanted.length) s.out('  Nobody, for once. The paper is blank and curling.');
    for (const w of wanted.slice(0, 6)) s.out(`  ${w.name}. Bounty ${w.bounty} coin, paid by the watch to whoever brings them down.`);
    const heard = this.game.town.rumours();
    if (heard.length) {
      s.out(c.label('Scrawled underneath'));
      for (const r of heard) s.out(`  ${r.text}.`);
    }
    const { rows } = await query(
      `SELECT p.name, n.text FROM notices n JOIN players p ON p.id = n.player_id WHERE n.at > now() - interval '1 day' ORDER BY n.at DESC LIMIT 8`,
    );
    s.out(c.label('Pinned notes'));
    if (!rows.length) s.out('  None. pin <a note> to put one up.');
    for (const r of rows) s.out(`  "${r.text}" (${r.name})`);
    s.out(c.dim('Paying work is on the board in the Gatherers\' Hall. pin <words> to pin a note of your own, unpin to take it down.'));
  }

  /** pin <words>: one note each, filtered, for a day. */
  async pin(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    if (p.roomId !== NOTICEBOARD_ROOM) return s.out('Notes go on the noticeboard in the market square.');
    const text = sanitize(rest, NOTE_MAX).trim();
    if (!text) return s.out(`pin <words>: a note of up to ${NOTE_MAX} letters, up for a day. One at a time.`);
    if (isFlagged(text)) return s.out('A passing watchman reads it over your shoulder and tears it down before the pin is in.');
    await query(
      `INSERT INTO notices (player_id, text, at) VALUES ($1, $2, now()) ON CONFLICT (player_id) DO UPDATE SET text = $2, at = now()`,
      [p.id, text],
    );
    s.out(c.system('You pin your note to the board, over somebody else\'s.'));
    this.game.toRoom(p.roomId, c.dim(`${p.name} pins a note to the noticeboard.`), s);
  }

  async unpin(s: Session): Promise<void> {
    const { rowCount } = await query('DELETE FROM notices WHERE player_id = $1', [s.player!.id]);
    s.out(rowCount ? 'You take your note down.' : 'You have no note on the board.');
  }
}
