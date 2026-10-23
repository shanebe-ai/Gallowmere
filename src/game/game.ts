import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { NpcBrain, type ActionType } from '../npc/brain.js';
import { addNote, getMemory } from '../npc/memory.js';
import { isFlagged } from './filter.js';
import { Session, type Connection } from './session.js';
import { c, capitalize, listJoin, sanitize, stripAnsi } from './text.js';
import { DIR_SHORT, OPPOSITE, World, type Direction, type Npc } from './world.js';

const MAX_INPUT = 300;
const MAX_ALIASES = 30;
const RECENT_LINES = 6;
const REFUSE_MS = 60_000;
const CHAT_WINDOW_MS = 120_000;
const LINKDEAD_GRACE_MS = 15_000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_TRIES_PER_MIN = 5;
const AMBIENT_EVERY_MS = 20_000;

const RESERVED = new Set(['admin', 'god', 'morda', 'guard', 'beggar', 'blacksmith', 'rats', 'rat', 'someone', 'self', 'me', 'all', 'here']);

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

const HELP: Record<string, string> = {
  look: 'look (l): look around.  look <someone> (l <someone>): look at a player or NPC.',
  move: 'north, south, east, west, up, down (n s e w u d): walk through an exit. Exits in the room text can be clicked.',
  say: "say <text> (or ' <text>): speak to everyone in the room. Name someone in it and they answer: say hi guard. A bare greeting works too: hello Morda.",
  emote: 'emote <text> (or : <text>): act it out. ": leans on the bar" shows "Shane leans on the bar".',
  talk: 'talk <npc> <text> (or say to <npc> <text>): speak to someone directly. talk guard on its own just says hello.',
  ask: 'ask <npc> about <topic>: ask an NPC about something.',
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
  private recent = new Map<string, string[]>();
  private refusals = new Map<string, number>();
  /** The AI character each player is in conversation with, and when they last spoke. */
  private chatting = new Map<number, { npcId: string; at: number }>();
  private linkdead = new Map<number, { timer: NodeJS.Timeout; roomId: string; name: string }>();
  private ambientTimer: NodeJS.Timeout | null = null;

  constructor(
    public world: World,
    private brain: NpcBrain,
    private opts: { random?: () => number; scriptedDelayMs?: number } = {},
  ) {}

  private rand(): number {
    return (this.opts.random ?? Math.random)();
  }

  startAmbient(): void {
    this.ambientTimer = setInterval(() => this.ambientTick(), AMBIENT_EVERY_MS);
    this.ambientTimer.unref();
  }

  stop(): void {
    if (this.ambientTimer) clearInterval(this.ambientTimer);
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
    return s;
  }

  async disconnect(s: Session): Promise<void> {
    this.sessions.delete(s);
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
    const { rows } = await query('SELECT id, name, password_hash, room_id, created_at FROM players WHERE lower(name)=lower($1)', [s.pendingName]);
    const r = rows[0];
    if (!r || !(await bcrypt.compare(pw, r.password_hash))) {
      failures.push(Date.now());
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
    this.showRoom(s);
    if (isNew) s.out(c.dim("Type help for commands. The Drowned Rat is south and west of the market, if you're thirsty."));
    this.updateStatusAll();
  }

  // ---------------------------------------------------------------- output helpers

  private playersIn(roomId: string, except?: Session): Session[] {
    return [...this.byPlayer.values()].filter((p) => p.player!.roomId === roomId && p !== except);
  }

  private toRoom(roomId: string, text: string, except?: Session): void {
    for (const p of this.playersIn(roomId, except)) p.out(text);
  }

  private updateStatus(s: Session): void {
    if (!s.player) return;
    const room = this.world.room(s.player.roomId);
    s.conn.setStatus({
      name: s.player.name,
      room: room.title,
      online: this.byPlayer.size,
      exits: room.exits.filter((e) => !e.hidden).map((e) => e.direction),
    });
  }

  private updateStatusAll(): void {
    for (const s of this.byPlayer.values()) this.updateStatus(s);
  }

  private showRoom(s: Session): void {
    const room = this.world.room(s.player!.roomId);
    s.out(c.title(room.title));
    s.out(room.description);
    // Who and what is here, one scannable line each. Every name can be clicked to look at it.
    const npcs = this.world.npcsIn(room.id).map((n) => n.card.listName ?? n.name);
    const players = this.playersIn(room.id, s).map((p) => p.player!.name);
    const things = room.features.map((f) => f.name);
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
    const rest = restParts.join(' ').trim();

    if (DIR_SHORT[verb]) return this.move(s, DIR_SHORT[verb]);

    switch (verb) {
      case 'l':
      case 'look':
      case 'examine':
      case 'x':
        return this.look(s, rest);
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
    const huh = ['Huh?', 'What?', "That doesn't mean anything here.", 'The fog swallows your words. Try help.'];
    s.out(huh[Math.floor(this.rand() * huh.length)]);
  }

  private isAdmin(s: Session): boolean {
    return !!s.player && config.adminNames.includes(s.player.name.toLowerCase());
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
    if (!exit) return s.out("You can't go that way.");
    this.toRoom(room.id, `${c.player(p.name)} leaves ${dir}.`, s);
    p.roomId = exit.to;
    await query('UPDATE players SET room_id=$2 WHERE id=$1', [p.id, p.roomId]);
    const from = OPPOSITE[dir];
    const fromText = from === 'up' ? 'above' : from === 'down' ? 'below' : `the ${from}`;
    this.toRoom(p.roomId, `${c.player(p.name)} arrives from ${fromText}.`, s);
    this.showRoom(s);
    this.updateStatus(s);
  }

  private look(s: Session, target: string): void {
    const t = target.replace(/^(at|the)\s+/i, '').trim().toLowerCase();
    if (!t) return this.showRoom(s);
    const roomId = s.player!.roomId;
    if (t === 'me' || t === 'self' || t === s.player!.name.toLowerCase()) {
      return s.out('You look like someone who just walked out of the fog. Damp, mostly.');
    }
    const npc = this.world.findNpc(roomId, t);
    if (npc) {
      s.out(c.npc(npc.card.short));
      s.out(npc.card.look);
      return s.out(c.dim(`To talk: talk ${npc.card.keywords[0]} <words>, or say something with "${npc.card.keywords[0]}" in it.`));
    }
    const feature = this.world.findFeature(roomId, t);
    if (feature) return s.out(feature.look);
    const other = this.playersIn(roomId, s).find((p) => p.player!.name.toLowerCase().startsWith(t));
    if (other) {
      other.out(`${c.player(s.player!.name)} looks you over.`);
      return s.out(`${c.player(other.player!.name)} is a stranger to these streets, still damp from the fog.`);
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
    const npc = this.mentionedNpc(p.roomId, text) ?? this.conversationPartner(s, text);
    if (npc) void this.npcRespond(s, npc, text);
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
    const parts = rest.replace(/^to\s+/i, '').split(' ');
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
    void this.npcRespond(s, npc, text);
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

  private pushRecent(key: string, line: string): void {
    const list = this.recent.get(key) ?? [];
    list.push(line);
    while (list.length > RECENT_LINES) list.shift();
    this.recent.set(key, list);
  }

  /** Runs one NPC reply. Code decides what happens; the brain only supplies words and a suggested action. */
  async npcRespond(s: Session, npc: Npc, playerLine: string): Promise<void> {
    const p = s.player!;
    const roomId = npc.roomId;

    if (npc.kind === 'scripted') {
      const line = this.brain.scripted(npc.id, npc.card);
      setTimeout(() => this.toRoom(roomId, c.npc(line)), this.opts.scriptedDelayMs ?? 400).unref();
      return;
    }

    if (s.aiPending) return s.out(c.dim(`${npc.name} is still working out what to say to you.`));
    const key = `${npc.id}:${p.id}`;
    if ((this.refusals.get(key) ?? 0) > Date.now()) {
      return this.toRoom(roomId, c.npc(`${npc.name} turns her back on ${p.name}.`));
    }

    s.aiPending = true;
    try {
      const memory = await getMemory(npc.id, p.id);
      const others = [
        ...this.playersIn(roomId, s).map((o) => o.player!.name),
        ...this.world.npcsIn(roomId).filter((n) => n.id !== npc.id).map((n) => n.name),
      ];
      const card = npc.card as any;
      const allowed: ActionType[] = ['none', 'remember', 'refuse'];
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
          scripted: card.scripted,
        },
        player: { id: p.id, name: p.name },
        memory,
        room: { title: this.world.room(roomId).title, others },
        recent: this.recent.get(key) ?? [],
        playerLine,
        allowedActions: allowed,
      });

      this.pushRecent(key, `${p.name}: ${playerLine}`);

      if (out.scriptedLine) {
        this.chatting.set(p.id, { npcId: npc.id, at: Date.now() });
        this.toRoom(roomId, c.npc(out.scriptedLine));
        this.pushRecent(key, `${npc.name}: ${stripAnsi(out.scriptedLine)}`);
        return;
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
    } catch (err) {
      console.error('npcRespond failed:', err);
      this.toRoom(roomId, c.npc(this.brain.scripted(npc.id, npc.card)));
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

  private score(s: Session): void {
    const p = s.player!;
    const days = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86_400_000);
    const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    s.out(`You are ${c.player(p.name)}, who came out of the fog ${when}.`);
    s.out(`You stand in ${this.world.room(p.roomId).title}.`);
  }

  private quit(s: Session): void {
    s.quitting = true;
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
