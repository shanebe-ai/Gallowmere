import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { NpcBrain, TRADE_ACTIONS, type ActionType, type NpcTurnOutput, type TradeContext } from '../npc/brain.js';
import { Commerce } from './commerce.js';
import { balances, Catalog, groupNames, restockShops, sweepRooms } from './economy.js';
import { addNote, getMemory } from '../npc/memory.js';
import { isFlagged } from './filter.js';
import { Session, type Connection } from './session.js';
import { c, capitalize, listJoin, sanitize, stripAnsi } from './text.js';
import { DIR_SHORT, OPPOSITE, World, cleanTarget, looseMatch, type Candidate, type Direction, type Feature, type Npc } from './world.js';
import { findItem } from './commerce.js';
import { listJoin as orList } from './text.js';

const MAX_INPUT = 300;
const MAX_ALIASES = 30;
const RECENT_LINES = 6;
const REFUSE_MS = 60_000;
const CHAT_WINDOW_MS = 120_000;
const LINKDEAD_GRACE_MS = 15_000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_TRIES_PER_MIN = 5;
const ACCOUNT_FAILS_LIMIT = 10; // wrong passwords for one character, from anywhere
const ACCOUNT_FAILS_WINDOW_MS = 15 * 60_000;
const LOGIN_TIMEOUT_MS = 2 * 60_000;
const CLEANUP_EVERY_MS = 10 * 60_000;
const AMBIENT_EVERY_MS = 20_000;

const RESERVED = new Set([
  'admin', 'god', 'morda', 'guard', 'beggar', 'blacksmith', 'rats', 'rat', 'someone', 'self', 'me', 'all', 'here',
  'dace', 'hamo', 'maud', 'osmund', 'father', 'hook', 'tilly', 'ingelram', 'butcher', 'gerald',
]);

const BANNER = [
  '',
  c.title('   ________       ____                                    '),
  c.title('  / ____/ /___ _/ / /___ _      ______ ___  ___  ________ '),
  c.title(' / / __/ / __ `/ / / __ \\ | /| / / __ `__ \\/ _ \\/ ___/ _ \\'),
  c.title('/ /_/ / / /_/ / / / /_/ / |/ |/ / / / / / /  __/ /  /  __/'),
  c.title('\\____/_/\\__,_/_/_/\\____/|__/|__/_/ /_/ /_/\\___/_/   \\___/ '),
  '',
  c.dim('  A walled river town. Grim, low magic, a little corrupt.'),
  c.dim('  The people here remember you.'),
  '',
];

const BANNER_NARROW = [
  '',
  c.title('  G A L L O W M E R E'),
  '',
  c.dim('  A walled river town. Grim, low magic, a little corrupt. The people here remember you.'),
  '',
];

/** Verbs for doing things to people and things, mapped to the action names rooms.json uses. */
const VERBS: Record<string, string> = {
  take: 'take', get: 'take', grab: 'take', steal: 'take', pick: 'take', pocket: 'take', yank: 'take',
  touch: 'touch', feel: 'touch', pat: 'touch', stroke: 'touch', poke: 'touch', rub: 'touch', prod: 'touch',
  open: 'open', pull: 'open', draw: 'open', part: 'open', move: 'open', lift: 'open', unlock: 'open',
  push: 'push', shove: 'push', bang: 'push', swat: 'push',
  knock: 'knock', rap: 'knock',
  read: 'read',
  search: 'search', rummage: 'search', check: 'search', dig: 'search',
  smell: 'smell', sniff: 'smell',
  sit: 'sit', rest: 'sit',
  climb: 'climb',
  use: 'use', play: 'use', pump: 'use', ring: 'use',
  drink: 'drink', sip: 'drink', quaff: 'drink',
  eat: 'eat', chew: 'eat',
  light: 'light',
  listen: 'listen', hear: 'listen',
  kick: 'kick',
};

/** When a thing has no line for a verb, try this one before the generic fallback. */
const VERB_FALLBACK: Record<string, string> = { knock: 'push', drink: 'use' };

/** How the room sees each verb when a thing has no line of its own. */
const VERB_SEEN: Record<string, string> = {
  take: 'tries to take', touch: 'touches', open: 'pulls at', push: 'pushes', read: 'reads', search: 'searches',
  smell: 'sniffs', sit: 'sits on', climb: 'tries to climb', use: 'fiddles with', kick: 'kicks',
  knock: 'knocks on', drink: 'drinks from', eat: 'tries to eat', light: 'tries to light', listen: 'listens at',
};

/** The same verbs done to a person: what you see, what others see. */
const VERB_PERSON: Record<string, [string, string]> = {
  take: ['grab at', 'grabs at'], touch: ['poke', 'pokes'], open: ['tug at', 'tugs at'], push: ['shove', 'shoves'],
  read: ['study', 'studies'], search: ['pat down', 'pats down'], smell: ['sniff', 'sniffs'], sit: ['sit on', 'sits on'],
  climb: ['try to climb', 'tries to climb'], use: ['try to use', 'tries to use'], kick: ['kick', 'kicks'],
  knock: ['knock on', 'knocks on'], drink: ['offer a drink to', 'offers a drink to'], eat: ['take a bite at', 'takes a bite at'],
  light: ['wave a light at', 'waves a light at'], listen: ['listen to', 'listens to'],
};

/** Fallback lines, so anything listed in a room answers every verb. */
const VERB_DEFAULT: Record<string, (name: string) => string> = {
  take: (n) => `You can't take ${n}. Not today, anyway.`,
  touch: (n) => `You touch ${n}. Damp, like everything in Gallowmere.`,
  open: (n) => `${capitalize(n)} doesn't open.`,
  push: (n) => `You push ${n}. Nothing happens.`,
  read: (n) => `There's nothing written on ${n}.`,
  search: (n) => `You search ${n} and find nothing worth having.`,
  smell: (n) => `${capitalize(n)} smells like the rest of Gallowmere: damp.`,
  sit: (n) => `You can't sit on ${n}.`,
  climb: (n) => `You can't climb ${n}.`,
  use: (n) => `You can't think of a use for ${n}.`,
  kick: (n) => `You kick ${n}. Your toe regrets it.`,
  knock: (n) => `You knock on ${n}. Nobody answers.`,
  drink: (n) => `You can't drink ${n}.`,
  eat: (n) => `You can't eat ${n}, however hungry Gallowmere makes you.`,
  light: (n) => `${capitalize(n)} won't light.`,
  listen: (n) => `You listen to ${n}. Nothing but the town: dripping, muttering, somewhere a dog.`,
};

const HELP: Record<string, string> = {
  look: 'look (l): look around.  look <someone> (l <someone>): look at a player or NPC.',
  move: 'north, south, east, west, up, down (n s e w u d): walk through an exit. Exits in the room text can be clicked.',
  say: "say <text> (or ' <text>): speak to everyone in the room. Name someone in it and they answer: say hi guard. A bare greeting works too: hello Morda.",
  emote: 'emote <text> (or : <text>): act it out. ": leans on the bar" shows "Shane leans on the bar".',
  talk: 'talk <npc> <text> (or say to <npc> <text>): speak to someone directly. talk guard on its own just says hello.',
  ask: 'ask <npc> about <topic>: ask an NPC about something.',
  things: 'Things listed under You see can be used: look, touch, take, open, push, knock, read, search, smell, listen, sit, climb, use, kick. Looking at something shows what it responds to.',
  items: 'inventory (i): what you carry.  take <item>, drop <item>, give <item or coins> to <someone>.  eat, drink, light, read, use, open things you carry.',
  shops: 'list: what a shopkeeper sells.  buy <item>, or haggle: buy rope for 3.  sell <item>, or sell lamp for 5.  appraise <item>.  During a haggle: offer <amount>, accept, walk away.',
  bank: 'At the counting house: deposit <amount or all>, withdraw <amount or all> (one copper in twenty), balance.',
  work: 'work: ask Maud at Market East for an odd job.  bribe <someone> <amount>: some people can be bought.',
  hint: 'hint: a nudge toward what to try next.',
  who: 'who: everyone in Gallowmere right now.',
  alias: 'alias: list your aliases.  alias <name> <command>: create one.  unalias <name>: remove one.',
  score: 'score: who you are and where you stand.',
  quit: 'quit: save and leave.',
};

interface Token {
  playerId: number;
  expires: number;
}

export class Game {
  sessions = new Set<Session>();
  private byPlayer = new Map<number, Session>();
  private tokens = new Map<string, Token>();
  private loginTries = new Map<string, number[]>();
  private accountFails = new Map<string, number[]>();
  private creations = new Map<string, number[]>();
  private loginTimers = new Map<Session, NodeJS.Timeout>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private recent = new Map<string, string[]>();
  private refusals = new Map<string, number>();
  /** The AI character each player is in conversation with, and when they last spoke. */
  private chatting = new Map<number, { npcId: string; at: number }>();
  private linkdead = new Map<number, { timer: NodeJS.Timeout; roomId: string; name: string }>();
  private ambientTimer: NodeJS.Timeout | null = null;
  catalog: Catalog;
  commerce: Commerce;
  private stockDay = '';

  constructor(
    public world: World,
    private brain: NpcBrain,
    private opts: { random?: () => number; scriptedDelayMs?: number } = {},
  ) {
    this.catalog = new Catalog();
    this.catalog.load();
    this.commerce = new Commerce(this, this.catalog);
  }

  /** Stocks the shops and fills their purses. Runs at start and again each new day. */
  async init(): Promise<void> {
    await restockShops(this.catalog);
    this.stockDay = new Date().toISOString().slice(0, 10);
  }

  private rand(): number {
    return (this.opts.random ?? Math.random)();
  }

  startAmbient(): void {
    this.ambientTimer = setInterval(() => this.ambientTick(), AMBIENT_EVERY_MS);
    this.ambientTimer.unref();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_EVERY_MS);
    this.cleanupTimer.unref();
  }

  /** Drops expired tokens and stale rate limit entries so memory stays flat. */
  cleanup(now = Date.now()): void {
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.stockDay && today !== this.stockDay) void this.init().catch((err) => console.error('restock failed:', err));
    void sweepRooms().catch((err) => console.error('sweep failed:', err));
    for (const [k, h] of this.commerce.haggles) if (h.expires <= now) this.commerce.haggles.delete(k);
    for (const [k, t] of this.tokens) if (t.expires <= now) this.tokens.delete(k);
    const prune = (m: Map<string, number[]>, windowMs: number) => {
      for (const [k, list] of m) {
        const keep = list.filter((t) => now - t < windowMs);
        if (keep.length) m.set(k, keep);
        else m.delete(k);
      }
    };
    prune(this.loginTries, 60_000);
    prune(this.accountFails, ACCOUNT_FAILS_WINDOW_MS);
    prune(this.creations, 60 * 60_000);
    for (const [k, until] of this.refusals) if (until <= now) this.refusals.delete(k);
    for (const [k, chat] of this.chatting) if (now - chat.at > CHAT_WINDOW_MS) this.chatting.delete(k);
  }

  stop(): void {
    if (this.ambientTimer) clearInterval(this.ambientTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const t of this.loginTimers.values()) clearTimeout(t);
    for (const l of this.linkdead.values()) clearTimeout(l.timer);
  }

  // ---------------------------------------------------------------- connections

  async connect(conn: Connection, token?: string | null, cols?: number): Promise<Session> {
    const s = new Session(conn);
    if (cols) s.setCols(cols);
    this.sessions.add(s);

    const tok = token ? this.tokens.get(token) : undefined;
    if (tok && tok.expires > Date.now()) {
      const player = await this.loadPlayer(tok.playerId);
      if (player) {
        await this.enterWorld(s, player, true);
        return s;
      }
    }
    conn.setToken(null);
    for (const line of s.cols >= 64 ? BANNER : BANNER_NARROW) s.out(line);
    this.promptName(s);
    // Nobody gets to sit at the login prompt forever.
    const timer = setTimeout(() => {
      if (s.state !== 'playing' && s.state !== 'closed') {
        s.out(c.dim('The fog closes in. Come back when you remember your name.'));
        s.conn.close();
      }
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
    this.loginTimers.set(s, timer);
    return s;
  }

  async disconnect(s: Session): Promise<void> {
    this.sessions.delete(s);
    const lt = this.loginTimers.get(s);
    if (lt) clearTimeout(lt);
    this.loginTimers.delete(s);
    const p = s.player;
    s.state = 'closed';
    if (!p || this.byPlayer.get(p.id) !== s) return;
    this.byPlayer.delete(p.id);
    await query('UPDATE players SET last_seen=now(), room_id=$2 WHERE id=$1', [p.id, p.roomId]);

    if (s.quitting) {
      this.toRoom(p.roomId, `${c.player(p.name)} fades into the fog.`);
      this.updateStatusAll();
      return;
    }
    // A dropped connection gets a short grace period before the room hears about it.
    const timer = setTimeout(() => {
      this.linkdead.delete(p.id);
      this.toRoom(p.roomId, `${c.player(p.name)} fades into the fog.`);
      this.updateStatusAll();
    }, LINKDEAD_GRACE_MS);
    timer.unref();
    this.linkdead.set(p.id, { timer, roomId: p.roomId, name: p.name });
  }

  async input(s: Session, raw: string): Promise<void> {
    if (s.state === 'closed') return;
    const line = sanitize(raw, MAX_INPUT);
    switch (s.state) {
      case 'name':
        return this.onName(s, line);
      case 'confirmNew':
        return this.onConfirmNew(s, line);
      case 'newPassword':
        return this.onNewPassword(s, String(raw ?? ''));
      case 'newPassword2':
        return this.onNewPassword2(s, String(raw ?? ''));
      case 'password':
        return this.onPassword(s, String(raw ?? ''));
      case 'playing':
        return this.command(s, line);
    }
  }

  // ---------------------------------------------------------------- login

  private promptName(s: Session): void {
    s.state = 'name';
    s.conn.setMode({ echo: true, prompt: 'Name: ' });
    s.out(c.system('By what name are you known?'));
  }

  private async onName(s: Session, line: string): Promise<void> {
    const name = line.trim();
    if (!/^[A-Za-z]{3,16}$/.test(name)) {
      s.out(c.error('Names are 3 to 16 letters, nothing else.'));
      return this.promptName(s);
    }
    if (RESERVED.has(name.toLowerCase())) {
      s.out(c.error('That name is taken by someone who was here first.'));
      return this.promptName(s);
    }
    s.pendingName = capitalize(name.toLowerCase());
    const { rows } = await query('SELECT id FROM players WHERE lower(name)=lower($1)', [name]);
    if (rows.length) {
      s.state = 'password';
      s.wrongPasswords = 0;
      s.conn.setMode({ echo: false, prompt: 'Password: ' });
      s.out(c.system(`Welcome back, ${s.pendingName}. Your password?`));
    } else {
      s.state = 'confirmNew';
      s.conn.setMode({ echo: true, prompt: '(y/n): ' });
      s.out(c.system(`No one in Gallowmere goes by ${s.pendingName}. Make a new character with that name? (y/n)`));
    }
  }

  private async onConfirmNew(s: Session, line: string): Promise<void> {
    if (/^y/i.test(line)) {
      const now = Date.now();
      const made = (this.creations.get(s.conn.ip) ?? []).filter((t) => now - t < 60 * 60_000);
      if (made.length >= config.newCharsPerHour) {
        s.out(c.error('Too many new characters from here lately. Try again in an hour, or log in with one you have.'));
        return this.promptName(s);
      }
      s.state = 'newPassword';
      s.conn.setMode({ echo: false, prompt: 'Password: ' });
      s.out(c.system('Choose a password, 6 characters or more.'));
    } else {
      this.promptName(s);
    }
  }

  private async onNewPassword(s: Session, pw: string): Promise<void> {
    if (pw.length < 6 || pw.length > 72) {
      s.out(c.error('Between 6 and 72 characters, please.'));
      return;
    }
    s.firstPassword = pw;
    s.state = 'newPassword2';
    s.conn.setMode({ echo: false, prompt: 'Again: ' });
    s.out(c.system('Once more, to be sure.'));
  }

  private async onNewPassword2(s: Session, pw: string): Promise<void> {
    if (pw !== s.firstPassword) {
      s.firstPassword = '';
      s.out(c.error("Those didn't match. Start the password again."));
      s.state = 'newPassword';
      s.conn.setMode({ echo: false, prompt: 'Password: ' });
      return;
    }
    const hash = await bcrypt.hash(pw, 10);
    s.firstPassword = '';
    let r;
    try {
      const { rows } = await query(
        'INSERT INTO players (name, password_hash, room_id) VALUES ($1,$2,$3) RETURNING id, name, room_id, created_at',
        [s.pendingName, hash, this.world.startRoom],
      );
      r = rows[0];
      const made = this.creations.get(s.conn.ip) ?? [];
      made.push(Date.now());
      this.creations.set(s.conn.ip, made);
    } catch {
      s.out(c.error('Someone took that name a moment ago. Try another.'));
      return this.promptName(s);
    }
    s.out('');
    s.out(c.dim('The fog parts. The gate looms. You have arrived in Gallowmere.'));
    await this.enterWorld(s, { id: r.id, name: r.name, roomId: r.room_id, createdAt: r.created_at }, false, true);
  }

  /** Failed password attempts per IP in the last minute. */
  private recentFailures(ip: string): number[] {
    const now = Date.now();
    const tries = (this.loginTries.get(ip) ?? []).filter((t) => now - t < 60_000);
    this.loginTries.set(ip, tries);
    return tries;
  }

  private async onPassword(s: Session, pw: string): Promise<void> {
    const failures = this.recentFailures(s.conn.ip);
    if (failures.length >= LOGIN_TRIES_PER_MIN) {
      s.out(c.error('Too many wrong passwords. Wait a minute and try again.'));
      return this.promptName(s);
    }
    const acct = s.pendingName.toLowerCase();
    const now = Date.now();
    const acctFails = (this.accountFails.get(acct) ?? []).filter((t) => now - t < ACCOUNT_FAILS_WINDOW_MS);
    this.accountFails.set(acct, acctFails);
    if (acctFails.length >= ACCOUNT_FAILS_LIMIT) {
      s.out(c.error('That character is locked for a few minutes after too many wrong passwords.'));
      return this.promptName(s);
    }
    const { rows } = await query('SELECT id, name, password_hash, room_id, created_at FROM players WHERE lower(name)=lower($1)', [s.pendingName]);
    const r = rows[0];
    if (!r || !(await bcrypt.compare(pw, r.password_hash))) {
      failures.push(Date.now());
      acctFails.push(Date.now());
      s.wrongPasswords++;
      s.out(c.error('Wrong password.'));
      if (s.wrongPasswords >= 3) return this.promptName(s);
      return;
    }
    await this.enterWorld(s, { id: r.id, name: r.name, roomId: r.room_id, createdAt: r.created_at }, false);
  }

  private async loadPlayer(id: number) {
    const { rows } = await query('SELECT id, name, room_id, created_at FROM players WHERE id=$1', [id]);
    const r = rows[0];
    return r ? { id: r.id as number, name: r.name as string, roomId: r.room_id as string, createdAt: r.created_at as Date } : null;
  }

  private async enterWorld(
    s: Session,
    player: { id: number; name: string; roomId: string; createdAt: Date },
    resumed: boolean,
    isNew = false,
  ): Promise<void> {
    // One body per character: an older connection is pushed out.
    const old = this.byPlayer.get(player.id);
    if (old && old !== s) {
      old.out(c.system('Someone else has stepped into your boots. Goodbye.'));
      old.state = 'closed';
      this.sessions.delete(old);
      old.conn.close();
      player.roomId = old.player?.roomId ?? player.roomId;
    }
    const ld = this.linkdead.get(player.id);
    if (ld) {
      clearTimeout(ld.timer);
      this.linkdead.delete(player.id);
      player.roomId = ld.roomId;
    }
    if (!this.world.rooms.has(player.roomId)) player.roomId = this.world.startRoom;

    s.player = player;
    s.state = 'playing';
    const lt = this.loginTimers.get(s);
    if (lt) clearTimeout(lt);
    this.loginTimers.delete(s);
    this.byPlayer.set(player.id, s);

    const { rows } = await query('SELECT alias, expansion FROM player_aliases WHERE player_id=$1', [player.id]);
    s.aliases = new Map(rows.map((r) => [r.alias, r.expansion]));

    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { playerId: player.id, expires: Date.now() + TOKEN_TTL_MS });
    s.conn.setToken(token);
    s.conn.setMode({ echo: true, prompt: '> ' });

    const quietly = resumed && (ld !== undefined || old !== undefined);
    if (resumed) s.out(c.dim('[Reconnected]'));
    if (!quietly && !old) this.toRoom(player.roomId, `${c.player(player.name)} steps out of the fog.`, s);
    await this.showRoom(s);
    if (isNew) s.out(c.dim("Type help for commands. The Drowned Rat is south and west of the market, if you're thirsty."));
    this.updateStatusAll();
  }

  // ---------------------------------------------------------------- output helpers

  playersIn(roomId: string, except?: Session): Session[] {
    return [...this.byPlayer.values()].filter((p) => p.player!.roomId === roomId && p !== except);
  }

  toRoom(roomId: string, text: string, except?: Session, except2?: Session): void {
    for (const p of this.playersIn(roomId, except)) if (p !== except2) p.out(text);
  }

  updateStatus(s: Session): void {
    if (!s.player) return;
    const p = s.player;
    void balances(p.id)
      .then(({ coin }) => {
        if (s.player !== p || s.state === 'closed') return;
        const room = this.world.room(p.roomId);
        s.conn.setStatus({
          name: p.name,
          room: room.title,
          online: this.byPlayer.size,
          exits: room.exits.filter((e) => !e.hidden).map((e) => e.direction),
          coin,
        });
      })
      .catch(() => undefined);
  }

  private updateStatusAll(): void {
    for (const s of this.byPlayer.values()) this.updateStatus(s);
  }

  private async showRoom(s: Session): Promise<void> {
    const room = this.world.room(s.player!.roomId);
    const floor = await this.commerce.roomItems(room.id);
    s.out(c.title(room.title));
    s.out(room.description);
    // Who and what is here, one scannable line each. Every name can be clicked to look at it.
    const npcs = this.world.npcsIn(room.id).map((n) => n.card.listName ?? n.name);
    const players = this.playersIn(room.id, s).map((p) => p.player!.name);
    const things = [...room.features.map((f) => f.name), ...groupNames(floor)];
    this.listLine(s, 'People:', npcs, c.npc);
    this.listLine(s, 'Players:', players, c.player);
    this.listLine(s, 'You see:', things, c.thing);
    const exits = room.exits.filter((e) => !e.hidden).map((e) => e.direction);
    s.out(c.exits(`Exits: ${exits.length ? exits.join(', ') : 'none'}.`));
  }

  /** One line per list, or one item per line when it would wrap, so no name is split. */
  private listLine(s: Session, label: string, items: string[], colour: (t: string) => string): void {
    if (!items.length) return;
    const pad = 'You see: '.length;
    const head = label.padEnd(pad - 1);
    const one = `${head} ${items.join(', ')}`;
    if (one.length <= s.cols - 1) return s.out(`${c.label(head)} ${colour(items.join(', '))}`);
    items.forEach((item, i) => {
      const lead = i === 0 ? c.label(head) + ' ' : ' '.repeat(pad);
      s.out(`${lead}${colour(item + (i < items.length - 1 ? ',' : ''))}`);
    });
  }

  // ---------------------------------------------------------------- commands

  async command(s: Session, line: string): Promise<void> {
    if (!line) return;
    line = this.expandAlias(s, line);

    if (line.startsWith("'") || line.startsWith('"')) return this.say(s, line.slice(1).trim());
    if (line.startsWith(':')) return this.emote(s, line.slice(1).trim());

    const [verbRaw, ...restParts] = line.split(' ');
    const verb = verbRaw.toLowerCase();
    let rest = restParts.join(' ').trim();

    if (DIR_SHORT[verb]) return this.move(s, DIR_SHORT[verb]);

    switch (verb) {
      case 'l':
      case 'look':
      case 'examine':
      case 'x': {
        if (!rest) return this.look(s, rest);
        const target = await this.resolveTarget(s, rest);
        return target === null ? undefined : this.look(s, target);
      }
      case 'go':
        if (DIR_SHORT[rest.toLowerCase()]) return this.move(s, DIR_SHORT[rest.toLowerCase()]);
        return s.out('Go where? Try north, south, east, west, up or down.');
      case 'say':
        // "say to guard hello" is the same as "talk guard hello".
        if (/^to\s+\S+\s+\S/i.test(rest) && this.world.findNpc(s.player!.roomId, rest.split(' ')[1])) return this.talk(s, rest);
        return this.say(s, rest);
      case 'hi':
      case 'hello':
      case 'hey':
      case 'howdy':
      case 'greetings':
      case 'evening':
      case 'morning':
      case 'oi':
        // A bare greeting is spoken out loud: "hi guard" says "hi guard".
        return this.say(s, line);
      case 'attack':
      case 'kill':
      case 'hit':
      case 'fight':
      case 'punch':
      case 'stab':
      case 'k':
        return this.attack(s, rest);
      case 'emote':
      case 'me':
        return this.emote(s, rest);
      case 'i':
      case 'inv':
      case 'inventory':
        return this.commerce.inventory(s);
      case 'drop':
        return this.commerce.drop(s, rest);
      case 'give':
      case 'hand':
        return this.commerce.give(s, rest);
      case 'list':
      case 'wares':
        return this.commerce.list(s);
      case 'buy':
      case 'purchase':
        return this.commerce.buy(s, rest);
      case 'sell':
        return this.commerce.sell(s, rest);
      case 'offer':
      case 'counter':
        return this.commerce.offer(s, rest);
      case 'accept':
      case 'deal':
        return this.commerce.accept(s);
      case 'walk':
        if (/^away/i.test(rest)) return this.commerce.walkAway(s);
        break;
      case 'decline':
      case 'refuse':
        return this.commerce.walkAway(s);
      case 'appraise':
      case 'value':
        return this.commerce.appraise(s, rest);
      case 'deposit':
        return this.commerce.deposit(s, rest);
      case 'withdraw':
        return this.commerce.withdraw(s, rest);
      case 'balance':
      case 'bank':
        return this.commerce.balance(s);
      case 'bribe':
        return this.commerce.bribe(s, rest);
      case 'work':
      case 'job':
        return this.commerce.work(s);
      case 'hint':
      case 'hints':
        return this.commerce.hint(s);
      case 'talk':
      case 'tell':
        return this.talk(s, rest);
      case 'ask':
        return this.ask(s, rest);
      case 'who':
        return this.who(s);
      case 'alias':
        return this.alias(s, rest);
      case 'unalias':
        return this.unalias(s, rest);
      case 'help':
      case '?':
      case 'commands':
        return this.help(s, rest);
      case 'score':
      case 'sc':
        return this.score(s);
      case 'quit':
      case 'exit':
      case 'logout':
        return this.quit(s);
      case 'aistats':
        if (this.isAdmin(s)) return this.aiStats(s);
        break;
    }
    if (VERBS[verb]) {
      const action = VERBS[verb];
      if (rest && !/^all\b/i.test(rest)) {
        const target = await this.resolveTarget(s, rest);
        if (target === null) return;
        rest = target;
      }
      // Your own things first, then things on the floor, then the room.
      if (action === 'take' && rest && (await this.commerce.take(s, rest))) return;
      if (['eat', 'drink', 'light', 'read', 'use', 'open', 'smell'].includes(action) && (await this.commerce.itemAction(s, action, rest))) return;
      return this.interact(s, action, verb, rest);
    }
    const huh = ['Huh?', 'What?', "That doesn't mean anything here.", 'The fog swallows your words. Try help.'];
    s.out(huh[Math.floor(this.rand() * huh.length)]);
  }

  private isAdmin(s: Session): boolean {
    return !!s.player && config.adminIds.includes(s.player.id);
  }

  expandAlias(s: Session, line: string): string {
    const space = line.indexOf(' ');
    const first = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const exp = s.aliases.get(first);
    if (!exp) return line;
    const args = space === -1 ? '' : line.slice(space + 1);
    return sanitize(args ? `${exp} ${args}` : exp, MAX_INPUT);
  }

  private async move(s: Session, dir: Direction): Promise<void> {
    const p = s.player!;
    const room = this.world.room(p.roomId);
    const exit = room.exits.find((e) => e.direction === dir);
    if (!exit) {
      if (dir === 'north' && room.id === 'moor_road') return s.out('The fog swallows the road. Not yet. Something is out there, and the town is not ready to meet it.');
      return s.out("You can't go that way.");
    }
    this.commerce.closeHaggle(p.id);
    this.toRoom(room.id, `${c.player(p.name)} leaves ${dir}.`, s);
    p.roomId = exit.to;
    await query('UPDATE players SET room_id=$2 WHERE id=$1', [p.id, p.roomId]);
    const from = OPPOSITE[dir];
    const fromText = from === 'up' ? 'above' : from === 'down' ? 'below' : `the ${from}`;
    this.toRoom(p.roomId, `${c.player(p.name)} arrives from ${fromText}.`, s);
    await this.showRoom(s);
    this.updateStatus(s);
  }

  private async look(s: Session, target: string): Promise<void> {
    const t = cleanTarget(target);
    if (!t) return await this.showRoom(s);
    const roomId = s.player!.roomId;
    if (t === 'me' || t === 'self' || t === 'myself' || t === s.player!.name.toLowerCase()) {
      return s.out('You look like someone who just walked out of the fog. Damp, mostly.');
    }
    const npc = this.world.findNpc(roomId, t);
    if (npc) {
      s.out(c.npc(npc.card.short));
      s.out(npc.card.look);
      return s.out(c.dim(`To talk: talk ${npc.card.keywords[0]} <words>, or say something with "${npc.card.keywords[0]}" in it.`));
    }
    const feature = this.world.findFeature(roomId, t);
    if (feature) {
      s.out(feature.look);
      return s.out(c.dim(`You could: ${this.featureVerbs(feature).join(', ')}.`));
    }
    if (await this.commerce.lookItem(s, target)) return;
    const other = this.findPlayerHere(s, t);
    if (other) {
      other.out(`${c.player(s.player!.name)} looks you over.`);
      return s.out(`${c.player(other.player!.name)} is a stranger to these streets, still damp from the fog.`);
    }
    s.out("You don't see that here.");
  }

  /**
   * Works out what the player means by what they typed, in the context of the room:
   * an exact name or keyword first, then the closest match among the people, things and
   * items here. "it" means the last thing they looked at or handled. Returns the words to
   * use, or null after telling the player the target is unclear.
   */
  async resolveTarget(s: Session, rest: string): Promise<string | null> {
    const p = s.player!;
    let t = cleanTarget(rest);
    if (['it', 'him', 'her', 'them'].includes(t)) {
      if (!s.lastTarget) {
        s.out('What do you mean by that? Look at something first.');
        return null;
      }
      return s.lastTarget;
    }
    t = t.replace(/^(up|down|out|over|around)\s+/, '');
    const floor = await this.commerce.roomItems(p.roomId);
    const mine = await this.commerce.myItems(s);
    const exact =
      this.world.findNpc(p.roomId, t)?.card.listName ??
      this.world.findNpc(p.roomId, t)?.name ??
      this.world.findFeature(p.roomId, t)?.name ??
      findItem(mine, rest)?.template.name ??
      findItem(floor, rest)?.template.name ??
      this.findPlayerHere(s, t)?.player!.name;
    if (exact) {
      s.lastTarget = exact;
      return rest;
    }
    if (['me', 'self', 'myself'].includes(t) || t === p.name.toLowerCase()) return rest;
    const cands: Candidate<string>[] = [
      ...this.world.npcsIn(p.roomId).map((n) => ({ name: n.card.listName ?? n.name, keywords: [n.name, ...n.card.keywords], ref: n.card.listName ?? n.name })),
      ...this.world.room(p.roomId).features.map((f) => ({ name: f.name, keywords: f.keywords, ref: f.name })),
      ...[...mine, ...floor].map((i) => ({ name: i.template.name, keywords: i.template.keywords, ref: i.template.name })),
      ...this.playersIn(p.roomId, s).map((o) => ({ name: o.player!.name, keywords: [o.player!.name.toLowerCase()], ref: o.player!.name })),
    ];
    const hit = looseMatch(rest, cands);
    if (!hit) return rest; // nothing close: let the command say so in its own words
    if ('ambiguous' in hit) {
      s.out(`Which do you mean: ${orList(hit.ambiguous).replace(/ and (?!.* and )/, ' or ')}?`);
      return null;
    }
    s.lastTarget = hit.ref;
    return hit.ref;
  }

  private findPlayerHere(s: Session, cleaned: string): Session | undefined {
    if (!cleaned) return undefined;
    const first = cleaned.split(' ')[0];
    return this.playersIn(s.player!.roomId, s).find((o) => o.player!.name.toLowerCase().startsWith(first));
  }

  /** The verbs a thing has its own lines for, shown after looking at it. */
  private featureVerbs(f: Feature): string[] {
    return Object.keys(f.actions ?? {}).sort();
  }

  /** take, touch, open and friends, on things, NPCs or players. Code decides what happens. */
  private async interact(s: Session, action: string, typed: string, rest: string): Promise<void> {
    const p = s.player!;
    const t = cleanTarget(rest.replace(/^(up|down|out|over|around)\s+/i, ''));
    if (!t) return s.out(`${capitalize(typed)} what?`);

    const feature = this.world.findFeature(p.roomId, t);
    if (feature) {
      const a = feature.actions?.[action] ?? (VERB_FALLBACK[action] ? feature.actions?.[VERB_FALLBACK[action]] : undefined);
      if (typeof a === 'object' && Array.isArray(a.scavenge)) {
        const spot = `${p.roomId}:${feature.keywords[0]}`;
        this.toRoom(p.roomId, `${c.player(p.name)} ${VERB_SEEN[action]} ${feature.name}.`, s);
        return void (await this.commerce.scavenge(s, spot, a.text, a.scavenge));
      }
      const text =
        typeof a === 'string'
          ? a
          : a?.text ?? (action === 'read' && /"|[A-Z]{3,}/.test(feature.look) ? feature.look : VERB_DEFAULT[action](feature.name));
      s.out(text);
      const seen = typeof a === 'object' && a.room ? a.room : `${VERB_SEEN[action]} ${feature.name}.`;
      this.toRoom(p.roomId, `${c.player(p.name)} ${seen}`, s);
      if (typeof a === 'object' && a.react) {
        const event = a.event ?? `${VERB_SEEN[action]} ${feature.name}`;
        const witness = this.world.npcsIn(p.roomId).find((n) => n.kind === 'ai');
        if (witness) void this.npcRespond(s, witness, event, 'event');
      }
      return;
    }

    const [mine, theirs] = VERB_PERSON[action];
    const npc = this.world.findNpc(p.roomId, t);
    if (npc) {
      const name = npc.card.listName ?? npc.name;
      s.out(`You ${mine} ${name}.`);
      this.toRoom(p.roomId, `${c.player(p.name)} ${theirs} ${name}.`, s);
      if (npc.kind === 'ai') void this.npcRespond(s, npc, `${theirs} you`, 'event');
      else void this.npcRespond(s, npc, typed);
      return;
    }

    const other = this.findPlayerHere(s, t);
    if (other) {
      s.out(`You ${mine} ${other.player!.name}.`);
      other.out(`${c.player(p.name)} ${theirs} you.`);
      this.toRoom(p.roomId, `${c.player(p.name)} ${theirs} ${other.player!.name}.`, s, other);
      return;
    }
    s.out("You don't see that here.");
  }

  private say(s: Session, text: string): void {
    if (!text) return s.out('Say what?');
    if (this.blockIfFlagged(s, text)) return;
    const p = s.player!;
    s.out(`You say, ${c.speech(`"${text}"`)}`);
    this.toRoom(p.roomId, `${c.player(p.name)} says, ${c.speech(`"${text}"`)}`, s);

    // Naming someone in the room counts as talking to them. AI characters win a tie.
    const npc = this.mentionedNpc(p.roomId, text) ?? this.looselyAddressed(p.roomId, text) ?? this.conversationPartner(s, text);
    if (npc) return void this.respondOrHaggle(s, npc, text);
    this.overheard(s);
  }

  /** "say hi to old tillt": a name close enough to someone here still reaches them. */
  looselyAddressed(roomId: string, text: string): Npc | undefined {
    const npcs = this.world.npcsIn(roomId);
    if (!npcs.length) return undefined;
    const cands = npcs.map((n) => ({
      name: n.name,
      keywords: [n.name, ...n.card.keywords].filter((k) => !k.includes(' ')),
      ref: n,
    }));
    const hit = looseMatch(text, cands);
    return hit && 'ref' in hit ? hit.ref : undefined;
  }

  private overheardAt = new Map<number, number>();

  /** Nobody was addressed, but people are listening: someone reacts, now and then. */
  private overheard(s: Session): void {
    const p = s.player!;
    const npcs = this.world.npcsIn(p.roomId).filter((n) => n.id !== 'rats');
    if (!npcs.length || this.playersIn(p.roomId, s).length) return;
    const last = this.overheardAt.get(p.id) ?? 0;
    if (Date.now() - last < 45_000) return;
    this.overheardAt.set(p.id, Date.now());
    const n = npcs[Math.floor(this.rand() * npcs.length)];
    const who = n.card.listName ?? n.name;
    const lines = [
      `${capitalize(who)} glances up at you, then away.`,
      `${capitalize(who)} squints at you. "Eh? Who are you talking to?"`,
      `${capitalize(who)} pretends not to hear.`,
      `${capitalize(who)} mutters something you don't catch.`,
      `${capitalize(who)} looks around, unsure if that was meant for them.`,
    ];
    const line = lines[Math.floor(this.rand() * lines.length)];
    setTimeout(() => this.toRoom(p.roomId, c.npc(line)), this.opts.scriptedDelayMs ?? 400).unref();
  }

  /**
   * Mid conversation, a plain say carries on talking to the same AI character,
   * unless the player has named another player in the room.
   */
  conversationPartner(s: Session, text: string): Npc | undefined {
    const p = s.player!;
    const chat = this.chatting.get(p.id);
    if (!chat || Date.now() - chat.at > CHAT_WINDOW_MS) return undefined;
    const npc = this.world.npcs.get(chat.npcId);
    if (!npc || npc.roomId !== p.roomId) return undefined;
    const lower = text.toLowerCase();
    if (this.playersIn(p.roomId, s).some((o) => new RegExp(`\\b${o.player!.name.toLowerCase()}\\b`).test(lower))) return undefined;
    return npc;
  }

  /** The NPC in the room whose name or keyword appears in the text, if any. */
  mentionedNpc(roomId: string, text: string): Npc | undefined {
    const lower = ` ${text.toLowerCase().replace(/[^a-z ]+/g, ' ')} `;
    const hits = this.world
      .npcsIn(roomId)
      .filter((n) => n.card.keywords.some((k) => lower.includes(` ${k} `)));
    return hits.find((n) => n.kind === 'ai') ?? hits[0];
  }

  private attack(s: Session, rest: string): void {
    const target = rest.replace(/^(the|at)\s+/i, '').trim();
    const roomId = s.player!.roomId;
    const npc = target ? this.world.findNpc(roomId, target.split(' ')[0]) : undefined;
    const other = target
      ? this.playersIn(roomId, s).find((o) => o.player!.name.toLowerCase().startsWith(target.toLowerCase()))
      : undefined;
    const who = npc ? npc.name : other ? other.player!.name : '';
    if (target && !who) return s.out("There's nobody like that here.");
    s.out(
      who
        ? `You size up ${who} and think better of it. Steel and blood come to Gallowmere soon, but not today.`
        : 'Attack what? Not that it matters yet: steel and blood come to Gallowmere soon, but not today.',
    );
    if (npc) this.toRoom(roomId, c.dim(`${s.player!.name} eyes ${npc.name} with murder in mind, then thinks better of it.`), s);
    if (other) other.out(c.dim(`${s.player!.name} eyes you with murder in mind, then thinks better of it.`));
  }

  private emote(s: Session, text: string): void {
    if (!text) return s.out('Do what?');
    if (this.blockIfFlagged(s, text)) return;
    const p = s.player!;
    const line = `${c.player(p.name)} ${text}`;
    s.out(line);
    this.toRoom(p.roomId, line, s);
  }

  private blockIfFlagged(s: Session, text: string): boolean {
    if (!isFlagged(text)) return false;
    void query('INSERT INTO flagged_lines (player_id, source, text) VALUES ($1,$2,$3)', [s.player?.id ?? null, 'player', text]);
    s.out(c.error('The words catch in your throat. Not here.'));
    return true;
  }

  private talk(s: Session, rest: string): void {
    const parts = rest.replace(/^(to|with)\s+/i, '').replace(/^(the|a|an)\s+/i, '').split(' ');
    const who = parts.shift() ?? '';
    let text = parts.join(' ').trim();
    if (!who) return s.out('Talk to whom? Try: talk guard hello');
    const npc = this.world.findNpc(s.player!.roomId, who);
    if (!npc) return s.out("There's nobody like that here.");
    if (!text) text = 'Hello.';
    if (this.blockIfFlagged(s, text)) return;
    const p = s.player!;
    s.out(`You say to ${c.npc(npc.name)}, ${c.speech(`"${text}"`)}`);
    this.toRoom(p.roomId, `${c.player(p.name)} says to ${c.npc(npc.name)}, ${c.speech(`"${text}"`)}`, s);
    void this.respondOrHaggle(s, npc, text);
  }

  private ask(s: Session, rest: string): void {
    const m = rest.match(/^(\S+)\s+(?:about\s+)?(.+)$/i);
    if (!m) return s.out('Try: ask morda about the town');
    const npc = this.world.findNpc(s.player!.roomId, m[1]);
    if (!npc) return s.out("There's nobody like that here.");
    const topic = m[2].trim();
    if (this.blockIfFlagged(s, topic)) return;
    const p = s.player!;
    s.out(`You ask ${c.npc(npc.name)} about ${topic}.`);
    this.toRoom(p.roomId, `${c.player(p.name)} asks ${c.npc(npc.name)} about ${topic}.`, s);
    void this.npcRespond(s, npc, `What can you tell me about ${topic}?`);
  }

  /** Mid haggle, talk to the shopkeeper goes through the haggle so they can answer with a price. */
  private async respondOrHaggle(s: Session, npc: Npc, text: string): Promise<void> {
    if (await this.commerce.haggleTalk(s, npc, text)) return;
    await this.npcRespond(s, npc, text);
  }

  private pushRecent(key: string, line: string): void {
    const list = this.recent.get(key) ?? [];
    list.push(line);
    while (list.length > RECENT_LINES) list.shift();
    this.recent.set(key, list);
  }

  /** Runs one NPC reply. Code decides what happens; the brain only supplies words and a suggested action. */
  async npcRespond(
    s: Session,
    npc: Npc,
    playerLine: string,
    kind: 'say' | 'event' = 'say',
    trade?: TradeContext,
  ): Promise<NpcTurnOutput | null> {
    const p = s.player!;
    const roomId = npc.roomId;

    if (npc.kind === 'scripted') {
      const line = this.brain.scripted(npc.id, npc.card);
      setTimeout(() => this.toRoom(roomId, c.npc(line)), this.opts.scriptedDelayMs ?? 400).unref();
      return null;
    }

    if (s.aiPending) {
      s.out(c.dim(`${npc.name} is still working out what to say to you.`));
      return null;
    }
    const key = `${npc.id}:${p.id}`;
    if ((this.refusals.get(key) ?? 0) > Date.now()) {
      this.toRoom(roomId, c.npc(`${npc.name} turns away from ${p.name}.`));
      return null;
    }

    s.aiPending = true;
    try {
      const memory = await getMemory(npc.id, p.id);
      const others = [
        ...this.playersIn(roomId, s).map((o) => o.player!.name),
        ...this.world.npcsIn(roomId).filter((n) => n.id !== npc.id).map((n) => n.name),
      ];
      const card = npc.card as any;
      const allowed: ActionType[] = ['none', 'remember', 'refuse', ...(trade ? TRADE_ACTIONS : [])];
      const out = await this.brain.turn({
        npcId: npc.id,
        npc: {
          name: npc.name,
          job: card.job,
          personality: card.personality,
          speech: card.speech,
          wants: card.wants,
          secret: card.secret,
          knows: card.knows,
          tradeStyle: card.tradeStyle,
          scripted: card.scripted,
        },
        player: { id: p.id, name: p.name },
        memory,
        room: { title: this.world.room(roomId).title, others },
        recent: this.recent.get(key) ?? [],
        playerLine,
        kind,
        trade,
        allowedActions: allowed,
      });

      this.pushRecent(key, kind === 'event' ? `(${p.name} ${playerLine})` : `${p.name}: ${playerLine}`);

      if (out.scriptedLine) {
        this.chatting.set(p.id, { npcId: npc.id, at: Date.now() });
        this.toRoom(roomId, c.npc(out.scriptedLine));
        this.pushRecent(key, `${npc.name}: ${stripAnsi(out.scriptedLine)}`);
        return out;
      }

      if (out.emote) {
        let emote = out.emote.replace(new RegExp(`^${npc.name}\\s+`, 'i'), '');
        if (!/[.!?"]$/.test(emote)) emote += '.';
        this.toRoom(roomId, c.npc(`${npc.name} ${emote}`));
      }
      if (out.say) {
        for (const o of this.playersIn(roomId)) {
          const to = o === s ? 'you' : p.name;
          o.out(`${c.npc(npc.name)} says to ${to}, ${c.speech(`"${out.say}"`)}`);
        }
        this.pushRecent(key, `${npc.name}: ${out.say}`);
      }

      // The engine applies only actions it allows.
      if (out.action.type === 'remember' && out.action.note) {
        await addNote(npc.id, p.id, out.action.note);
      } else if (out.action.type === 'refuse') {
        this.refusals.set(key, Date.now() + REFUSE_MS);
      }
      if (out.action.type === 'refuse') this.chatting.delete(p.id);
      else this.chatting.set(p.id, { npcId: npc.id, at: Date.now() });
      return out;
    } catch (err) {
      console.error('npcRespond failed:', err);
      this.toRoom(roomId, c.npc(this.brain.scripted(npc.id, npc.card)));
      return null;
    } finally {
      s.aiPending = false;
    }
  }

  private who(s: Session): void {
    const list = [...this.byPlayer.values()]
      .map((o) => o.player!)
      .sort((a, b) => a.name.localeCompare(b.name));
    s.out(c.title(`In Gallowmere now (${list.length}):`));
    for (const o of list) s.out(`  ${c.player(o.name.padEnd(16))} ${c.dim(this.world.room(o.roomId).title)}`);
  }

  private async alias(s: Session, rest: string): Promise<void> {
    if (!rest) {
      if (!s.aliases.size) return s.out('No aliases yet. Try: alias hi say Hello there');
      s.out(c.title('Your aliases:'));
      for (const [a, e] of [...s.aliases].sort()) s.out(`  ${a.padEnd(10)} ${e}`);
      return;
    }
    const [nameRaw, ...exp] = rest.split(' ');
    const name = nameRaw.toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(name)) return s.out('Alias names are 1 to 10 letters or digits.');
    if (['alias', 'unalias', 'quit'].includes(name)) return s.out("You can't alias that.");
    const expansion = exp.join(' ').trim();
    if (!expansion) {
      const cur = s.aliases.get(name);
      return s.out(cur ? `${name} = ${cur}` : `No alias called ${name}.`);
    }
    if (!s.aliases.has(name) && s.aliases.size >= MAX_ALIASES) return s.out(`That's ${MAX_ALIASES} aliases already. Remove one first.`);
    s.aliases.set(name, expansion);
    await query(
      `INSERT INTO player_aliases (player_id, alias, expansion) VALUES ($1,$2,$3)
       ON CONFLICT (player_id, alias) DO UPDATE SET expansion=$3`,
      [s.player!.id, name, expansion],
    );
    s.out(`Alias set: ${name} = ${expansion}`);
  }

  private async unalias(s: Session, rest: string): Promise<void> {
    const name = rest.trim().toLowerCase();
    if (!s.aliases.delete(name)) return s.out(`No alias called ${name || 'that'}.`);
    await query('DELETE FROM player_aliases WHERE player_id=$1 AND alias=$2', [s.player!.id, name]);
    s.out(`Alias ${name} removed.`);
  }

  private help(s: Session, topic: string): void {
    const t = topic.toLowerCase();
    const key = DIR_SHORT[t] ? 'move' : t === 'l' ? 'look' : t;
    if (key && HELP[key]) return s.out(HELP[key]);
    s.out(c.title('Commands'));
    for (const line of Object.values(HELP)) s.out(`  ${line}`);
    if (this.isAdmin(s)) s.out('  aistats: AI calls, latency and fallbacks per player, last 24 hours.');
  }

  private async score(s: Session): Promise<void> {
    const p = s.player!;
    const days = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86_400_000);
    const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    s.out(`You are ${c.player(p.name)}, who came out of the fog ${when}.`);
    s.out(`You stand in ${this.world.room(p.roomId).title}.`);
    const { coin, bank } = await balances(p.id);
    s.out(`Coin: ${coin} in your purse, ${bank} in the counting house.`);
  }

  private quit(s: Session): void {
    s.quitting = true;
    // Quitting signs this character out everywhere: saved reconnect tokens stop working.
    for (const [k, t] of this.tokens) if (t.playerId === s.player!.id) this.tokens.delete(k);
    s.out(c.dim('You pull your collar up and walk back into the fog. Saved.'));
    s.conn.setToken(null);
    s.conn.close();
  }

  private async aiStats(s: Session): Promise<void> {
    const { rows } = await query(
      `SELECT coalesce(p.name, '?') AS name,
              count(*)::int AS calls,
              count(*) FILTER (WHERE u.provider <> 'scripted')::int AS ai_calls,
              count(*) FILTER (WHERE u.fallback_used)::int AS fallbacks,
              count(DISTINCT date_trunc('hour', u.created_at))::int AS hours,
              coalesce(round(avg(u.latency_ms) FILTER (WHERE u.provider <> 'scripted')), 0)::int AS avg_ms,
              coalesce(sum(u.tokens_in), 0)::int AS tin,
              coalesce(sum(u.tokens_out), 0)::int AS tout
         FROM ai_usage u LEFT JOIN players p ON p.id = u.player_id
        WHERE u.created_at > now() - interval '24 hours'
        GROUP BY p.name ORDER BY calls DESC`,
    );
    if (!rows.length) return s.out('No NPC conversations in the last 24 hours.');
    s.out(c.title('NPC lines, last 24 hours'));
    s.out(c.dim('  player           lines  ai  per hr  fallback  avg ms  tokens in/out   cost at paid rates'));
    for (const r of rows) {
      const perHour = (r.calls / Math.max(1, r.hours)).toFixed(1);
      const fb = r.calls ? Math.round((100 * r.fallbacks) / r.calls) : 0;
      // Groq Llama 3.1 8B paid pricing, as a ceiling: $0.05 in, $0.08 out per million tokens.
      const cost = (r.tin * 0.05 + r.tout * 0.08) / 1_000_000;
      s.out(
        `  ${String(r.name).padEnd(16)} ${String(r.calls).padStart(5)} ${String(r.ai_calls).padStart(3)} ${perHour.padStart(7)} ${`${fb}%`.padStart(9)} ${String(r.avg_ms).padStart(7)}  ${`${r.tin}/${r.tout}`.padStart(13)}   $${cost.toFixed(5)}`,
      );
    }
    s.out(c.dim('  Free tier means $0 actual; the last column is what it would cost on paid Groq.'));
    const byNpc = await query(
      `SELECT npc_id, count(*)::int AS calls, count(*) FILTER (WHERE provider <> 'scripted')::int AS ai_calls
         FROM ai_usage WHERE created_at > now() - interval '24 hours' GROUP BY npc_id ORDER BY calls DESC`,
    );
    s.out(c.title('By character'));
    for (const r of byNpc.rows) s.out(`  ${String(r.npc_id).padEnd(16)} ${String(r.calls).padStart(5)} lines, ${r.ai_calls} from the AI`);
  }

  // ---------------------------------------------------------------- ambience

  ambientTick(): void {
    for (const npc of this.world.npcs.values()) {
      const lines = npc.card.ambient ?? [];
      if (!lines.length || !this.playersIn(npc.roomId).length) continue;
      if (this.rand() < 0.15) this.toRoom(npc.roomId, c.dim(lines[Math.floor(this.rand() * lines.length)]));
    }
  }

  onlineNames(): string[] {
    return [...this.byPlayer.values()].map((s) => s.player!.name);
  }

  listOnline(): string {
    return listJoin(this.onlineNames());
  }
}
