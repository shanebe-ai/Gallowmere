// Life inside the walls: drink and its stages, the Sleeping Lantern, the Gatherers' Hall,
// rumours, characters talking to each other, and the lamplighter's rounds.
// Code decides every stage, price and rank; the AI only ever adds words.

import { query } from '../db/pool.js';
import { createItem, deleteItem, getFlag, itemsOf, moveCoin, moveItem, NotEnough, setFlag, tx, type ItemTemplate } from './economy.js';
import { findItem } from './commerce.js';
import { MOBS } from './mobs.js';
import { maxHealthFor, type PlayerState } from './combat.js';
import type { Session } from './session.js';
import { c, capitalize } from './text.js';
import type { Npc } from './world.js';
import type { Game } from './game.js';

const DRINK_FADE_MS = 3 * 60_000; // one drink's worth wears off every three minutes
const OUT_COLD_MS = 3 * 60_000;
const RENT_MS = 12 * 60 * 60_000; // till morning
const CHEST_LIMIT = 10;
const BANTER_EVERY_MS = 4 * 60_000;
const RUMOUR_MS = 24 * 60 * 60_000;
const FRESH_MS = 15 * 60_000;
const STALE_MS = 25 * 60_000;
export const PRIVATE_ROOMS = ['lantern_east', 'lantern_west'];

export type Stage = 'sober' | 'merry' | 'tipsy' | 'drunk' | 'legless';

export function stageOf(drink: number): Stage {
  // A whisker of wear between two quick drinks doesn't count.
  drink = Math.round(drink * 10) / 10;
  if (drink >= 7) return 'legless';
  if (drink >= 5) return 'drunk';
  if (drink >= 3) return 'tipsy';
  if (drink >= 1) return 'merry';
  return 'sober';
}

/** Drunk talk, by code: s goes to sh, letters double, the odd hic. Same words every time for the same dice. */
export function slur(text: string, r: () => number): string {
  const words = text.split(' ').map((w) => {
    let out = w.replace(/s(?=[aeiouh ]|$)/g, 'sh').replace(/S(?=[aeiouh ]|$)/g, 'Sh');
    if (out.length > 3 && r() < 0.3) {
      const i = 1 + Math.floor(r() * (out.length - 2));
      if (/[a-z]/i.test(out[i])) out = out.slice(0, i) + out[i] + out.slice(i);
    }
    return out;
  });
  if (words.length > 2 && r() < 0.5) words.splice(1 + Math.floor(r() * (words.length - 1)), 0, '*hic*');
  const out = words.join(' ').replace(/ing\b/g, "in'");
  // However it came out, it never comes out sober.
  return out === text ? `${out} *hic*` : out;
}

/** The Gatherers' ranks, by bodies delivered. Each rank is worth a coin more a body. */
export const RANKS: Array<[number, string]> = [
  [0, 'Carrier'],
  [5, 'Bearer'],
  [15, 'Gatherer'],
  [30, "Warden's Hand"],
];

export function rankOf(bodies: number): { index: number; name: string } {
  let index = 0;
  RANKS.forEach(([min], i) => {
    if (bodies >= min) index = i;
  });
  return { index, name: RANKS[index][1] };
}

/** What the hall pays for a fresh body, before freshness, membership and rank. */
export function bodyPay(kind: string, mobKind: string | null): number {
  if (mobKind === 'captain') return 25;
  const spec = mobKind ? MOBS[mobKind as keyof typeof MOBS] : undefined;
  if (kind === 'rat' || spec?.corpse === 'rat') return 1;
  const level = spec?.level ?? 1;
  if (spec?.street) return Math.min(5, 2 + level);
  return Math.min(10, 5 + level);
}

/** Who wants which bodies this hour. Three are chalked on the board at a time. */
const WANTS: Array<{ who: string; kind: string; pay: number; why: string }> = [
  { who: 'Hook', kind: 'cutpurse', pay: 8, why: 'competition' },
  { who: 'the butcher', kind: 'boar', pay: 13, why: 'no questions' },
  { who: 'Old Tilly', kind: 'fox', pay: 9, why: 'for the pelt, unspoiled' },
  { who: 'Father Osmund', kind: 'drunk', pay: 6, why: "a pauper's grave, decently done" },
  { who: 'the duty sergeant', kind: 'brigand', pay: 12, why: 'for the gibbet' },
  { who: 'Amos the gravedigger', kind: 'ragpicker', pay: 6, why: 'he says he knew them' },
  { who: 'Maud', kind: 'rat', pay: 3, why: 'to nail up as a warning' },
  { who: 'Cole the charcoal burner', kind: 'deer', pay: 10, why: 'for the hide and the winter' },
  { who: 'Hamo', kind: 'bruiser', pay: 9, why: "an old debt, he won't say" },
  { who: 'a physician who writes from Vesna', kind: 'wolf', pay: 14, why: 'for study' },
  { who: 'Warden Crane herself', kind: 'bear', pay: 30, why: 'for the hall' },
  { who: 'the harbourmaster', kind: 'cutthroat', pay: 15, why: 'paid in advance, by somebody' },
  { who: 'Morda', kind: 'goat', pay: 8, why: 'stew' },
  { who: 'Hook', kind: 'preacher', pay: 7, why: 'peace and quiet' },
];

const NOUN: Record<string, string> = {
  cutpurse: 'a cutpurse', boar: 'a wild boar', fox: 'a fox', drunk: 'a drunk', brigand: 'a brigand', ragpicker: 'a rag picker',
  rat: 'a rat', deer: 'a deer', bruiser: 'a dock bruiser', wolf: 'a wolf', bear: 'a bear', cutthroat: 'a brigand cutthroat',
  goat: 'a mountain goat', preacher: 'a street preacher',
};

/** Street names the lamplighter walks, in order, round and back. */
const LAMP_ROUND = ['gate_road', 'market_square', 'market_west', 'smithy_row', 'market_west', 'market_square', 'market_east', 'butchers_alley', 'market_east', 'market_square', 'wet_lane', 'docks_stair', 'river_docks', 'docks_stair', 'wet_lane', 'market_square'];

export class Town {
  private banterAt = new Map<string, number>();
  private boardTaken = new Map<number, Set<number>>();
  private rumourCache: Array<{ playerId: number | null; text: string; at: number }> = [];
  private bodies = new Map<number, number>(); // delivered, per Gatherer
  private lampStep = 0;
  private lampAt = 0;

  constructor(private game: Game) {}

  private get r(): () => number {
    return () => this.game.random();
  }

  async init(): Promise<void> {
    const { rows } = await query(`SELECT player_id, text, at FROM rumours WHERE at > now() - interval '1 day' ORDER BY at DESC LIMIT 10`);
    this.rumourCache = rows.map((r) => ({ playerId: r.player_id, text: r.text, at: new Date(r.at).getTime() }));
  }

  // ---------------------------------------------------------------- drink

  /** Wears drink off with time. */
  sober(st: PlayerState, now = Date.now()): void {
    const fade = (now - st.drinkAt) / DRINK_FADE_MS;
    st.drink = Math.max(0, st.drink - fade);
    st.drinkAt = now;
  }

  stage(st: PlayerState): Stage {
    this.sober(st);
    return stageOf(st.drink);
  }

  drunkWords(st: PlayerState): string | null {
    switch (this.stage(st)) {
      case 'merry':
        return 'You are merry: warm, a little loose, nothing worse.';
      case 'tipsy':
        return 'You are tipsy: the odd burp gets out, and the room is friendlier than it was.';
      case 'drunk':
        return 'You are drunk: your words slur, your feet wander, and your aim is worse. Morda will serve you no more.';
      case 'legless':
        return 'You are legless.';
      default:
        return null;
    }
  }

  /** Something was eaten or drunk: drink adds up, food and water take the edge off. */
  consumed(s: Session, st: PlayerState, t: ItemTemplate): void {
    this.sober(st);
    const before = stageOf(st.drink);
    if (t.id === 'ale') st.drink += 1;
    else if (t.id === 'gin') st.drink += 2;
    else if (t.id === 'water' || t.kind === 'food') st.drink = Math.max(0, st.drink - (t.id === 'water' ? 2 : 1.5));
    else return;
    const after = stageOf(st.drink);
    if ((t.id === 'ale' || t.id === 'gin') && after === 'merry') {
      const max = maxHealthFor(st.level);
      if (st.health < max) {
        st.health += 1;
        st.dirty = true;
        this.game.updateStatus(s);
      }
    }
    if (after === before) {
      if (after !== 'sober' && (t.id === 'water' || t.kind === 'food')) s.out(c.dim('It soaks up some of the drink.'));
      return;
    }
    const p = s.player!;
    switch (after) {
      case 'merry':
        return s.out(c.dim('A warm glow spreads through you. You are merry.'));
      case 'tipsy':
        s.out(c.dim('The room tilts very slightly, in a friendly way. You are tipsy.'));
        return this.game.toRoom(p.roomId, c.dim(`${p.name} is getting a bit pink about the ears.`), s);
      case 'drunk':
        s.out(c.error("The floor is not where you left it. You are drunk: your words come out wrong, and your feet may take you the wrong way."));
        return this.game.toRoom(p.roomId, c.dim(`${p.name} is swaying gently, like a boat at a jetty.`), s);
      case 'legless':
        return this.passOut(s, st);
      default:
        if (before !== 'sober') s.out(c.dim('Your head clears.'));
    }
  }

  passOut(s: Session, st: PlayerState): void {
    const p = s.player!;
    st.outUntil = Date.now() + OUT_COLD_MS;
    this.game.combat.endFightsWith(`p:${p.id}`);
    s.out(c.error('You try to stand up, and the ground comes up to meet you instead. You are out cold.'));
    this.game.toRoom(p.roomId, c.error(`${p.name} slides gently to the ground and lies there, out cold.`), s);
    void this.rumour(p.id, `${p.name} was seen out cold in ${this.game.world.room(p.roomId).title}`);
  }

  /** Out cold: nothing to do but lie there. Quitting still works; so does looking at your own wounds. */
  isOut(st: PlayerState | undefined, now = Date.now()): boolean {
    return !!st && st.outUntil > now;
  }

  /** Morda won't serve the drunk. */
  refuseSale(s: Session, npc: Npc, templateId: string): string | null {
    if (npc.id !== 'morda' || (templateId !== 'ale' && templateId !== 'gin')) return null;
    const st = this.game.combat.state(s.player!.id);
    if (!st) return null;
    const stage = this.stage(st);
    if (stage !== 'drunk' && stage !== 'legless') return null;
    return c.npc('Morda takes the mug back out of your reach. "You\'ve had your lot. Water, or bed. Old Peg\'s is out the back, through the yard."');
  }

  /** Drunk feet: one move in eight goes the wrong way. Returns the way you actually go. */
  wrongTurn(s: Session, wanted: string): string | null {
    const st = this.game.combat.state(s.player!.id);
    if (!st || this.stage(st) !== 'drunk' || this.r() >= 1 / 8) return null;
    const room = this.game.world.room(s.player!.roomId);
    const ways = room.exits.filter((e) => !e.hidden && e.direction !== wanted && !room.locks[e.direction]);
    if (!ways.length) return null;
    const way = ways[Math.floor(this.r() * ways.length)];
    s.out(c.dim(`You meant to go ${wanted}, but the street had other ideas.`));
    return way.direction;
  }

  /** The say of a drunk. */
  speech(s: Session, text: string): string {
    const st = this.game.combat.state(s.player!.id);
    if (!st) return text;
    const stage = this.stage(st);
    return stage === 'drunk' || stage === 'legless' ? slur(text, this.r) : text;
  }

  // ---------------------------------------------------------------- the Sleeping Lantern

  private async rental(playerId: number): Promise<{ kind: 'bed' | 'room'; room: string } | null> {
    const f = await getFlag(playerId, 'inn');
    if (!f || !f.value) return null;
    const [kind, room, until] = f.value.split(':');
    if (Number(until) < Date.now()) return null;
    return { kind: kind as 'bed' | 'room', room };
  }

  /** Who has each private room tonight. */
  private async roomsTaken(): Promise<Map<string, number>> {
    const { rows } = await query(`SELECT player_id, value FROM player_flags WHERE flag='inn' AND value LIKE 'room:%'`);
    const taken = new Map<string, number>();
    for (const r of rows) {
      const [, room, until] = String(r.value).split(':');
      if (Number(until) > Date.now()) taken.set(room, r.player_id);
    }
    return taken;
  }

  async rent(s: Session, what: string): Promise<void> {
    const p = s.player!;
    if (!this.game.world.npcsIn(p.roomId).some((n) => n.id === 'peg')) return s.out("Beds are rented from Old Peg at the Sleeping Lantern, south through the Rat's yard.");
    const want = /room|private|chest/i.test(what) ? 'room' : /bed|loft/i.test(what) || !what ? 'bed' : null;
    if (!want) return s.out('Rent what? rent bed (2 coin, the loft) or rent room (6 coin, private, with a chest).');
    const have = await this.rental(p.id);
    if (have && (have.kind === want || have.kind === 'room')) return s.out(c.npc(`Old Peg doesn't look up. "You've paid already, duck. ${have.kind === 'room' ? `The ${have.room === 'lantern_east' ? 'east' : 'west'} room, up the stairs.` : 'Loft, up the stairs.'}"`));
    let room = 'lantern_loft';
    if (want === 'room') {
      const taken = await this.roomsTaken();
      const free = PRIVATE_ROOMS.find((r) => !taken.has(r) || taken.get(r) === p.id);
      if (!free) return s.out(c.npc('"Both rooms are taken tonight. There\'s the loft: rent bed."'));
      room = free;
    }
    const price = want === 'room' ? 6 : 2;
    try {
      await tx((cl) => moveCoin(cl, p.id, -price, 0, `inn:${want}`));
    } catch (err) {
      if (err instanceof NotEnough) return s.out(c.npc(`"${price} coin, duck. Come back when you have it."`));
      throw err;
    }
    await setFlag(p.id, 'inn', `${want}:${room}:${Date.now() + RENT_MS}`);
    const where = want === 'room' ? `the ${room === 'lantern_east' ? 'east' : 'west'} room, at the top of the stairs. There's a chest: store and retrieve` : 'the loft, up the stairs. Any bed that\'s empty';
    s.out(c.npc(`Old Peg takes your ${price} coin and hands you a key on a string. "Till morning. ${capitalize(where)}. Then sleep."`));
    this.game.toRoom(p.roomId, `${c.player(p.name)} rents a ${want} from Old Peg.`, s);
    this.game.updateStatus(s);
  }

  /** Only the one who rented a private room gets through its door. */
  async canEnterPrivate(s: Session, roomId: string): Promise<string | null> {
    if (!PRIVATE_ROOMS.includes(roomId)) return null;
    const have = await this.rental(s.player!.id);
    if (have?.kind === 'room' && have.room === roomId) return null;
    return 'The door is locked. Rent a room from Old Peg downstairs: rent room.';
  }

  async sleep(s: Session): Promise<void> {
    const p = s.player!;
    const st = await this.game.combat.load(p);
    if (this.game.combat.inCombat(p.id)) return s.out("Sleep? Now? Someone is trying to kill you.");
    if (st.asleep) return s.out('You are already asleep. Snoring, even.');
    const room = this.game.world.room(p.roomId);
    let rented = false;
    if (room.flags.includes('inn')) {
      const have = await this.rental(p.id);
      if (p.roomId === 'sleeping_lantern') return s.out(c.npc(have ? '"Beds are upstairs, duck."' : '"Not on my benches. Rent a bed: rent bed."'));
      if (!have) return s.out(c.npc('Old Peg\'s voice comes up the stairs: "Rent first, sleep after!"'));
      if (p.roomId === 'lantern_loft' && have.kind === 'room') return s.out('Your room is through one of those doors. Sleep there.');
      rented = true;
    }
    st.asleep = { rented, since: Date.now() };
    if (rented) {
      s.out(c.system('You pull the blanket up and are asleep before your head is down. You will heal while you sleep. Type anything to wake.'));
    } else {
      s.out(c.system('You curl up where you are and close your eyes. Type anything to wake.'));
      if (room.flags.includes('street')) s.out(c.error('Sleeping in the street, you are fair game for cutpurses, and the cart men may take you for dead.'));
    }
    this.game.toRoom(p.roomId, `${c.player(p.name)} lies down and goes to sleep.`, s);
  }

  /** Any command wakes a sleeper. */
  wake(s: Session, why?: string): void {
    const st = this.game.combat.state(s.player!.id);
    if (!st?.asleep) return;
    const rented = st.asleep.rented;
    const long = Date.now() - st.asleep.since > 60_000;
    st.asleep = null;
    if (rented && long) {
      st.drink = 0;
      st.drinkAt = Date.now();
    } else if (long) {
      st.drink = Math.max(0, st.drink / 2);
    }
    s.out(c.system(why ?? (rented && long ? 'You wake rested and clear headed.' : 'You wake up.')));
    this.game.toRoom(s.player!.roomId, `${c.player(s.player!.name)} wakes up.`, s);
    this.game.updateStatus(s);
  }

  private async chestHere(s: Session): Promise<boolean> {
    const p = s.player!;
    if (!PRIVATE_ROOMS.includes(p.roomId)) {
      s.out('Your chest is in your private room at the Sleeping Lantern, if you have rented one.');
      return false;
    }
    const have = await this.rental(p.id);
    if (have?.kind !== 'room' || have.room !== p.roomId) {
      s.out('This is not your room tonight.');
      return false;
    }
    return true;
  }

  async store(s: Session, rest: string): Promise<void> {
    if (!(await this.chestHere(s))) return;
    const p = s.player!;
    if (!rest) return s.out('Store what? store <item>');
    const item = findItem(await this.game.commerce.myItems(s), rest);
    if (!item) return s.out("You aren't carrying that.");
    const inside = await itemsOf(this.game.catalog, { type: 'chest', id: p.id });
    if (inside.length >= CHEST_LIMIT) return s.out(`The chest is full: ${CHEST_LIMIT} things at most.`);
    if (item.template.kind === 'job') return s.out("That's Maud's. Take it to her.");
    const ok = await tx((cl) => moveItem(cl, item.id, { type: 'player', id: p.id }, { type: 'chest', id: p.id }));
    if (!ok) return s.out("You aren't carrying that anymore.");
    s.out(`You put ${item.template.name} in the chest and turn the key. ${c.dim(`(${inside.length + 1}/${CHEST_LIMIT})`)}`);
  }

  async retrieve(s: Session, rest: string): Promise<void> {
    if (!(await this.chestHere(s))) return;
    const p = s.player!;
    const inside = await itemsOf(this.game.catalog, { type: 'chest', id: p.id });
    if (!rest) {
      s.out(c.title('In your chest:'));
      if (!inside.length) return s.out('  Nothing.');
      for (const i of inside) s.out(`  ${c.thing(i.template.name)}`);
      return s.out(c.dim('retrieve <item> to take one out.'));
    }
    const item = findItem(inside, rest);
    if (!item) return s.out("That isn't in your chest.");
    const mine = await this.game.commerce.myItems(s);
    const load = mine.reduce((w, i) => w + i.template.weight, 0) + this.game.combat.extraLoad(p.id);
    if (load + item.template.weight > 20) return s.out("You can't carry that as well.");
    const ok = await tx((cl) => moveItem(cl, item.id, { type: 'chest', id: p.id }, { type: 'player', id: p.id }));
    if (!ok) return;
    s.out(`You take ${item.template.name} out of the chest.`);
  }

  // ---------------------------------------------------------------- the Gatherers' Hall

  private atHall(s: Session): boolean {
    return this.game.world.npcsIn(s.player!.roomId).some((n) => n.id === 'crane');
  }

  async gathererCount(playerId: number): Promise<number | null> {
    if (this.bodies.has(playerId)) return this.bodies.get(playerId)!;
    const f = await getFlag(playerId, 'gatherer');
    if (!f) return null;
    this.bodies.set(playerId, Number(f.value) || 0);
    return this.bodies.get(playerId)!;
  }

  /** "Bearer of the Gatherers", for who. Only from what's already loaded, so who never waits. */
  title(playerId: number): string | null {
    const n = this.bodies.get(playerId);
    return n === undefined ? null : `${rankOf(n).name} of the Gatherers`;
  }

  async join(s: Session): Promise<void> {
    const p = s.player!;
    if (!this.atHall(s)) return s.out("You join the Gatherers at their hall, east off Butcher's Alley.");
    if ((await this.gathererCount(p.id)) !== null) return s.out(c.npc('Crane does not look up. "You are already in the ledger."'));
    try {
      await tx((cl) => moveCoin(cl, p.id, -1, 0, 'joined the gatherers'));
    } catch (err) {
      if (err instanceof NotEnough) return s.out(c.npc('"One coin to join. Not a copper less."'));
      throw err;
    }
    await setFlag(p.id, 'gatherer', '0');
    this.bodies.set(p.id, 0);
    s.out(c.npc(`Warden Crane writes your name in the ledger, blots it, and turns the book to face you. "Carrier ${p.name}. Bring them fresh. Type deliver when you do."`));
    this.game.toRoom(p.roomId, `${c.player(p.name)} signs the Gatherers' ledger.`, s);
    this.game.updateStatus(s);
  }

  /** This hour's three wants, the same for everyone. */
  boardNow(now = Date.now()): Array<{ i: number; who: string; kind: string; pay: number; why: string; taken: boolean }> {
    const hour = Math.floor(now / 3_600_000);
    const picks: number[] = [];
    let seed = hour * 2654435761;
    while (picks.length < 3) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const i = seed % WANTS.length;
      if (!picks.includes(i)) picks.push(i);
    }
    const taken = this.boardTaken.get(hour) ?? new Set<number>();
    return picks.map((i) => ({ i, ...WANTS[i], taken: taken.has(i) }));
  }

  board(s: Session): void {
    if (s.player!.roomId !== 'gatherers_hall') return s.out("The wanted board hangs in the Gatherers' Hall, east off Butcher's Alley.");
    s.out(c.title('Wanted, this hour:'));
    for (const w of this.boardNow()) {
      const line = `${capitalize(w.who)} wants ${NOUN[w.kind] ?? w.kind}, ${w.why}. ${w.pay} coin.`;
      s.out(`  ${w.taken ? c.dim(`${line} (filled)`) : c.thing(line)}`);
    }
    s.out(c.dim('Fresh bodies only. The board is wiped and chalked again every hour. Members of the Gatherers only.'));
  }

  async deliver(s: Session): Promise<void> {
    const p = s.player!;
    if (!this.atHall(s)) return s.out("Bodies are delivered to Warden Crane at the Gatherers' Hall, east off Butcher's Alley.");
    const st = await this.game.combat.load(p);
    if (!st.carrying) return s.out(c.npc('Crane looks at your empty shoulders. "Deliver what, exactly?"'));
    const { rows } = await query('SELECT id, kind, name, mob_kind, died_at FROM corpses WHERE id=$1', [st.carrying]);
    const k = rows[0];
    if (!k) {
      st.carrying = null;
      return s.out('The body is gone.');
    }
    if (k.kind === 'player') return s.out(c.npc('Crane closes the ledger on her finger. "Not one of ours. The temple takes their own. Father Osmund."'));
    const age = Date.now() - new Date(k.died_at).getTime();
    if (age > STALE_MS) return s.out(c.npc('Crane lifts the sacking, sniffs once, and lets it fall. "Too far gone. The butcher, perhaps. Or the river."'));
    const count = await this.gathererCount(p.id);
    const member = count !== null;
    let pay = bodyPay(k.kind, k.mob_kind);
    let wanted: { i: number; who: string; pay: number } | undefined;
    if (member) {
      const want = this.boardNow().find((w) => !w.taken && (w.kind === k.mob_kind || (w.kind === 'rat' && k.kind === 'rat')));
      if (want) {
        wanted = want;
        pay = want.pay;
      }
    }
    const notes: string[] = [];
    if (!wanted && age > FRESH_MS) {
      pay = Math.max(1, Math.floor(pay / 2));
      notes.push('not fresh, half');
    }
    if (!member) {
      pay = Math.max(1, Math.floor(pay / 2));
      notes.push('not a member, half');
    } else if (!wanted) {
      pay += rankOf(count!).index;
    }
    const corpseId = Number(k.id);
    try {
      await tx(async (cl) => {
        const { rowCount } = await cl.query('DELETE FROM corpses WHERE id=$1 AND carried_by=$2', [corpseId, p.id]);
        if (rowCount !== 1) throw new Error('gone');
        await cl.query(`DELETE FROM items WHERE owner_type='corpse' AND owner_id=$1`, [String(corpseId)]);
        await moveCoin(cl, p.id, pay, 0, `delivered ${k.name} to the gatherers`);
      });
    } catch {
      st.carrying = null;
      return s.out('The body is gone.');
    }
    st.carrying = null;
    if (wanted) {
      const hour = Math.floor(Date.now() / 3_600_000);
      const set = this.boardTaken.get(hour) ?? new Set<number>();
      set.add(wanted.i);
      this.boardTaken.clear();
      this.boardTaken.set(hour, set);
    }
    s.out(c.npc(`Warden Crane lifts the sacking, checks the face against nothing in particular, and writes. "${k.name}. ${pay} coin."${wanted ? ` She chalks a line through ${wanted.who}'s want on the board.` : ''}`));
    if (notes.length) s.out(c.dim(`(${notes.join('; ')})`));
    if (!member) s.out(c.dim('Members are paid in full: join gatherers, one coin.'));
    if (member) {
      const before = rankOf(count!);
      const now = count! + 1;
      this.bodies.set(p.id, now);
      await setFlag(p.id, 'gatherer', String(now));
      const after = rankOf(now);
      if (after.index > before.index) s.out(c.title(`Crane turns the ledger round and writes something beside your name. "${after.name}." Each body pays a coin more now.`));
    }
    this.game.toRoom(p.roomId, `${c.player(p.name)} delivers the corpse of ${k.name} to Warden Crane.`, s);
    this.game.updateStatus(s);
  }

  // ---------------------------------------------------------------- Morda's kitchen

  /** Give Morda fish or meat and she cooks it, for a coin: big catches become a pie. */
  async cook(s: Session, itemId: number, t: ItemTemplate): Promise<void> {
    const p = s.player!;
    const big = ['pike', 'trout', 'venison', 'boar_meat', 'goat_meat', 'grandmother_pike', 'rabbit'].includes(t.id);
    const result = big ? 'pie' : 'stew';
    try {
      await tx(async (cl) => {
        if (!(await deleteItem(cl, itemId, { type: 'player', id: p.id }))) throw new Error('gone');
        await moveCoin(cl, p.id, -1, 0, `morda cooked ${t.id}`);
        await createItem(cl, result, { type: 'player', id: p.id });
      });
    } catch (err) {
      if (err instanceof NotEnough) return s.out(c.npc('Morda pushes it back across the bar. "A coin for the cooking. Fire isn\'t free."'));
      return s.out("You aren't carrying that anymore.");
    }
    s.out(c.npc(big ? `Morda weighs ${t.name} in one hand, nods, and takes it back to the kitchen. Some time later she bangs down a hot pie in front of you and takes a coin.` : `Morda tips ${t.name} into the stew pot without ceremony and ladles you out a bowl. "A coin."`));
    if (t.id === 'grandmother_pike') await this.rumour(p.id, `${p.name} had the Grandmother pike baked in a pie at the Drowned Rat`);
    this.game.toRoom(p.roomId, `Morda cooks something ${p.name} brought in.`, s);
    this.game.updateStatus(s);
  }

  // ---------------------------------------------------------------- rumours

  async rumour(playerId: number | null, text: string): Promise<void> {
    await query('INSERT INTO rumours (player_id, text) VALUES ($1,$2)', [playerId, text]);
    this.rumourCache.unshift({ playerId, text, at: Date.now() });
    this.rumourCache = this.rumourCache.filter((r) => Date.now() - r.at < RUMOUR_MS).slice(0, 10);
  }

  rumours(): Array<{ playerId: number | null; text: string }> {
    return this.rumourCache.filter((r) => Date.now() - r.at < RUMOUR_MS).slice(0, 3);
  }

  /** What a townsperson has heard, and how the player in front of them looks, for their prompt. */
  noteFor(npc: Npc, playerId: number): string | undefined {
    if (npc.mob || npc.card.mute) return undefined;
    const parts: string[] = [];
    const heard = this.rumours();
    if (heard.length) parts.push(`Talk of the town lately: ${heard.map((r) => r.text).join('; ')}.`);
    const mine = heard.find((r) => r.playerId === playerId);
    if (mine) parts.push(`The person in front of you is the one people are talking about: ${mine.text}.`);
    const st = this.game.combat.state(playerId);
    if (st) {
      const stage = this.stage(st);
      if (stage === 'tipsy') parts.push('They are a bit tipsy.');
      if (stage === 'drunk' || stage === 'legless') parts.push('They are visibly drunk: swaying and slurring.');
    }
    return parts.length ? parts.join(' ') : undefined;
  }

  // ---------------------------------------------------------------- the beat of the town

  /** Every few seconds: drink wears off, the drunk burp, the out cold come round, sleepers heal and get robbed. */
  async tick(now = Date.now()): Promise<void> {
    for (const st of this.game.combat.players.values()) {
      const s = this.game.sessionOf(st.id);
      if (!s?.player) continue;
      this.sober(st, now);
      const roomId = s.player.roomId;
      if (st.outUntil && st.outUntil <= now) {
        st.outUntil = 0;
        st.drink = Math.min(st.drink, 4);
        s.out(c.system('You come round in a heap, your head splitting. Somebody has been sick, possibly you.'));
        this.game.toRoom(roomId, `${c.player(st.name)} groans and sits up.`, s);
        continue;
      }
      const stage = stageOf(st.drink);
      if ((stage === 'tipsy' || stage === 'drunk') && !st.asleep && !st.outUntil && this.r() < 0.15) {
        const burps: Array<[string, string]> = [
          ['You burp, loudly, and look surprised about it.', 'burps, loudly, and looks surprised about it.'],
          ['You hiccup.', 'hiccups.'],
          ['You let out a burp that rattles the shutters.', 'lets out a burp that rattles the shutters.'],
          ['You hiccup, apologise, and hiccup again.', 'hiccups, apologises, and hiccups again.'],
        ];
        const [mine, theirs] = burps[Math.floor(this.r() * burps.length)];
        s.out(c.dim(mine));
        this.game.toRoom(roomId, c.dim(`${st.name} ${theirs}`), s);
      }
      // Sleeping it off in a paid bed: you wake once you're whole.
      if (st.asleep?.rented && st.health >= maxHealthFor(st.level) && now - st.asleep.since > 60_000) this.wake(s, 'You wake whole, rested and clear headed.');
      // The out cold and the rough sleepers are easy pickings.
      if ((st.outUntil > now || (st.asleep && !st.asleep.rented)) && !this.game.world.room(roomId).flags.includes('sanctuary')) {
        const thief = this.game.combat.mobsIn(roomId).find((m) => m.kind === 'cutpurse' && !m.target);
        if (thief && this.r() < 0.3) await this.robbed(s, st, this.game.combat.mobName(thief));
      }
    }
    await this.lamplighter(now);
    this.banter(now);
  }

  private async robbed(s: Session, st: PlayerState, by: string): Promise<void> {
    const { rows } = await query('SELECT coin FROM players WHERE id=$1', [st.id]);
    const take = Math.ceil((rows[0]?.coin ?? 0) / 3);
    if (take <= 0) return;
    await tx((cl) => moveCoin(cl, st.id, -take, 0, `robbed in their sleep by ${by}`));
    s.out(c.error(`In your stupor you feel a hand in your purse. When you can look, ${take} coin are gone.`));
    this.game.toRoom(s.player!.roomId, c.dim(`${capitalize(by)} goes through ${st.name}'s pockets.`), s);
    this.game.updateStatus(s);
  }

  /** Tobin walks his round, a street at a time. */
  private async lamplighter(now: number): Promise<void> {
    const tobin = this.game.world.npcs.get('lamplighter');
    if (!tobin || now - this.lampAt < 90_000) return;
    this.lampAt = now;
    const from = tobin.roomId;
    this.lampStep = (this.lampStep + 1) % LAMP_ROUND.length;
    const to = LAMP_ROUND[this.lampStep];
    if (to === from) return;
    this.game.toRoom(from, c.dim('Tobin shoulders his ladder and moves on.'));
    tobin.roomId = to;
    this.game.toRoom(to, c.dim('Tobin the lamplighter arrives with his ladder and his pole.'));
  }

  /** Now and then, two characters in a room with a player in it trade a line or two. */
  banter(now = Date.now(), force = false): void {
    const rooms = new Set<string>();
    for (const s of this.game.sessions) if (s.player && s.state === 'playing') rooms.add(s.player.roomId);
    for (const roomId of rooms) {
      if (now - (this.banterAt.get(roomId) ?? 0) < BANTER_EVERY_MS) continue;
      const talkers = this.game.world.npcsIn(roomId).filter((n) => !n.mob && !n.card.mute && n.kind !== 'scripted' && n.id !== 'gatevoice');
      if (talkers.length < 2) continue;
      if (!force && this.r() >= 0.15) continue;
      this.banterAt.set(roomId, now);
      const a = talkers[Math.floor(this.r() * talkers.length)];
      const b = talkers.filter((x) => x !== a)[Math.floor(this.r() * (talkers.length - 1))];
      const listener = this.game.playersIn(roomId)[0];
      if (!listener) continue;
      const heard = this.rumours();
      const topics = [
        ...(heard.length ? [`what people are saying: ${heard[Math.floor(this.r() * heard.length)].text}`] : []),
        `${listener.player!.name}, who is standing right there listening`,
        'how things are in town today',
        'the north road and what is out there',
      ];
      const topic = topics[Math.floor(this.r() * topics.length)];
      void this.game.npcBanter(a, b, topic, listener).catch(() => undefined);
    }
  }

  banterTimes(): Map<string, number> {
    return this.banterAt;
  }
}
