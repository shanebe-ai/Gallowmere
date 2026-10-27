import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { NpcBrain, TRADE_ACTIONS, type ActionType, type NpcTurnOutput, type Replies, type TradeContext } from '../npc/brain.js';
import { Commerce } from './commerce.js';
import { Combat, MAX_LEVEL, maxHealthFor, xpForLevel } from './combat.js';
import { Town } from './town.js';
import { Wilds } from './wilds.js';
import { SOCIALS, socialEvent, socialLines } from './socials.js';
import { PlagueCart, type CartOptions } from './cart.js';
import type { AIService } from '../ai/service.js';
import { avg, BENCH_DEFAULTS, BENCH_LINES, runBench, type LiveModel } from '../ai/bench.js';
import { balances, Catalog, deleteItem, groupNames, restockShops, sweepRooms, tx } from './economy.js';
import { addNote, getMemory } from '../npc/memory.js';
import { isFlagged } from './filter.js';
import { Session, type Connection } from './session.js';
import { c, capitalize, listJoin, nameKey, sanitize, stripAnsi } from './text.js';
import { DIR_SHORT, OPPOSITE, World, cleanTarget, distance, looseMatch, type Candidate, type Direction, type Feature, type Npc } from './world.js';
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
  'sergeant', 'bess', 'fishwife', 'nib', 'runner', 'amos', 'gravedigger', 'tobin', 'lamplighter', 'cole', 'burner',
  'ferryman', 'keeper', 'crane', 'warden', 'peg', 'wendel', 'regular', 'voice', 'captain', 'brigand', 'wight', 'vesna',
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

/**
 * The notebook: places worth remembering, grouped, with a note and the word to travel there.
 * Only places the player has found show up.
 */
export const JOURNAL: Array<{ group: string; room: string; note: string; travel: string }> = [
  { group: 'Sanctuaries (no fighting)', room: 'nave', note: 'Father Osmund: heal, bandages, pilgrim\'s tokens, burials, recover your corpse', travel: 'nave' },
  { group: 'Sanctuaries (no fighting)', room: 'temple_of_ash', note: 'where you wake when you die', travel: 'temple of ash' },
  { group: 'Sanctuaries (no fighting)', room: 'healers_ward', note: 'quiet beds, you heal faster', travel: 'healers ward' },
  { group: 'Sanctuaries (no fighting)', room: 'ossuary', note: 'lay a body down here for the burial fee', travel: 'ossuary' },
  { group: 'Sanctuaries (no fighting)', room: 'counting_house', note: 'Ingelram: deposit, withdraw, balance. Banked coin is safe from the cart', travel: 'bank' },
  { group: 'Shops', room: 'maud_shop', note: 'Maud: food, rope, lamps, odd jobs. Buys junk, tools and rat tails', travel: 'maud' },
  { group: 'Shops', room: 'smithy_row', note: 'Hamo: weapons and armour. Buys tools and weapons', travel: 'smith' },
  { group: 'Shops', room: 'curio_shop', note: 'Tilly: trinkets. Buys junk and valuables, never haggles', travel: 'tilly' },
  { group: 'Shops', room: 'hook_den', note: 'Hook: buys anything, sells keys, has whatever the cart took', travel: 'hook' },
  { group: 'Shops', room: 'drowned_rat', note: 'Morda: ale, stew, bread. Rest by the fire to heal. No fighting', travel: 'tavern' },
  { group: 'Work and bounties', room: 'watch_house', note: 'the duty sergeant pays bounties on cutpurses', travel: 'watch' },
  { group: 'Work and bounties', room: 'butchers_alley', note: 'the butcher buys bodies, no questions asked', travel: 'butcher' },
  { group: 'Work and bounties', room: 'fish_market', note: "Maud's sack waits here when you've taken her odd job", travel: 'fish market' },
  { group: 'Danger', room: 'sewer_grate', note: 'rats to fight, tails to sell', travel: 'sewer' },
  { group: 'Danger', room: 'sealed_door', note: 'the iron door: a key, or level 5 to force it', travel: 'iron door' },
  { group: 'Danger', room: 'the_nest', note: 'the rat king, back once a day', travel: 'nest' },
  { group: 'Sanctuaries (no fighting)', room: 'sleeping_lantern', note: 'Old Peg: rent a bed or a room, sleep it off, a chest for your things', travel: 'inn' },
  { group: 'Sanctuaries (no fighting)', room: 'shrine', note: 'the ritual heals you once a day; the keeper sells incense and fox charms; fortunes at the tree behind', travel: 'shrine' },
  { group: 'Work and bounties', room: 'gatherers_hall', note: 'Warden Crane: join gatherers, deliver bodies, read the board', travel: 'gatherers' },
  { group: 'Shops', room: 'ew_clearing', note: 'Cole the charcoal burner: buys hides and pelts, sells torches, a fire to cook at', travel: 'clearing' },
  { group: 'Fishing and the forest', room: 'drovers_ford', note: 'trout and minnows at the ford', travel: 'ford' },
  { group: 'Fishing and the forest', room: 'mere_jetty', note: 'perch and pike off the jetty; the ferryman rows to the island for a coin', travel: 'jetty' },
  { group: 'Fishing and the forest', room: 'falls_pool', note: 'trout in the plunge pool', travel: 'falls' },
  { group: 'Fishing and the forest', room: 'burnt_waystation', note: 'a fire on the road to cook at', travel: 'waystation' },
  { group: 'Fishing and the forest', room: 'ew_runs', note: 'rabbit runs: set snare, check snare', travel: 'rabbit runs' },
  { group: 'Danger', room: 'brigands_bend', note: 'brigands stop travellers here and ask a toll', travel: 'bend' },
  { group: 'Danger', room: 'camp_tents', note: 'the brigand camp, deep in the Blackwood', travel: 'camp' },
  { group: 'Danger', room: 'bear_cave', note: 'the bear, in the dark', travel: 'bear cave' },
  { group: 'Ways in and out', room: 'north_gate', note: 'Dace: news and bribes. The north road runs to Vesna', travel: 'gate' },
  { group: 'Ways in and out', room: 'smugglers_cut', note: 'a dry way between the cistern and the hulk', travel: 'smugglers cut' },
  { group: 'Ways in and out', room: 'shut_gate', note: 'the gate of Vesna, shut. Knock if you like', travel: 'vesna' },
];

/** Tucked into the front of every notebook. */
export const OSMUND_NOTE = [
  'Welcome to Gallowmere, stranger. You will find it damp, unkind and expensive, and you will stay anyway; everyone does.',
  'If you are hurt, come to me in the nave, east of the Temple of Ash. Rest there and your wounds close; I can bind them faster, for a coin. Nobody may draw a blade in my house.',
  'Bank your coin with Ingelram before the bell tolls. And if you die, you will wake on my floor. It happens to the best of us. Mostly to the worst.',
  'Father Osmund',
];

/** Places every character knows the way to from the start. */
export const KNOWN_FROM_START = ['nave'];

/** Verbs for doing things to people and things, mapped to the action names rooms.json uses. */
/**
 * Commands a typo may be read as. Only harmless ones: a slip should never buy, sell, give,
 * drop, fight or quit for you.
 */
const FORGIVING = [
  'health', 'travel', 'journal', 'recipes', 'board', 'look', 'examine', 'say', 'ask', 'talk', 'tell', 'list', 'wares', 'inventory', 'help', 'score', 'who', 'hint',
  'appraise', 'balance', 'emote', 'north', 'south', 'east', 'west', 'down',
  'read', 'search', 'smell', 'listen', 'touch', 'knock', 'climb', 'hello', 'greetings',
];

/** The one harmless command a typed word is a single slip away from, if there is exactly one. */
export function forgiveCommand(word: string): string | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  const close = FORGIVING.filter((c) => c !== w && distance(w, c) <= 1);
  return close.length === 1 ? close[0] : null;
}

const VERBS: Record<string, string> = {
  take: 'take', get: 'take', grab: 'take', steal: 'take', pick: 'take', pocket: 'take', yank: 'take',
  touch: 'touch', feel: 'touch', pat: 'touch', stroke: 'touch', poke: 'touch', rub: 'touch', prod: 'touch',
  open: 'open', pull: 'open', draw: 'open', part: 'open', move: 'open', lift: 'open', unlock: 'open',
  push: 'push', shove: 'push', bang: 'push', swat: 'push',
  knock: 'knock', rap: 'knock',
  read: 'read',
  search: 'search', rummage: 'search', check: 'search',
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
  emote: 'emote <text> (or : <text>): act it out. ": leans on the bar" shows "Shane leans on the bar".  emotes: the ready made ones, like wave, laugh, nod, bow, hug, shrug, wink, dance. Alone or at someone: wave morda, laugh at bob.',
  talk: 'talk <npc> <text> (or say to <npc> <text>): speak to someone directly. talk guard on its own just says hello.',
  ask: 'ask <npc> about <topic>, or ask <npc> <question>: ask someone something. Alone with someone, the name can be left off.',
  things: 'Things listed under You see can be used: look, touch, take, open, push, knock, read, search, smell, listen, sit, climb, use, kick. Looking at something shows what it responds to.',
  items: 'inventory (i): what you carry.  take <item>, drop <item>, give <item or coins> to <someone>.  eat, drink, light, read, use, open things you carry.',
  shops: 'list: what a shopkeeper sells.  buy <item>, or haggle: buy rope for 3.  sell <item>, or sell lamp for 5.  appraise <item>.  During a haggle: offer <amount>, accept, walk away.',
  bank: 'At the counting house: deposit <amount or all>, withdraw <amount or all> (one copper in twenty), balance.',
  work: 'work: ask Maud at Market East for an odd job.  bribe <someone> <amount>: some people can be bought.',
  hint: 'hint: a nudge toward what to try next.',
  journal: "journal (j): your notebook of useful places you've found: sanctuaries, shops, the bank, bounties, danger. Each with the word to travel there.",
  travel: "travel <place>: walk somewhere you've been before, one room at a time (travel nave, travel tavern, travel bank). travel on its own lists the places you know. Type anything to stop. A pilgrim's token from Father Osmund takes you straight to the nave: crush token.",
  fight: 'attack <someone> (kill, k): start a fight.  flee: run for it.  consider <someone>: size them up.  health (hp): your wounds, your weapon and your odds.  wield <weapon>, wear <armour>, remove.  bandage: bind your wounds out of a fight. No fighting in the temple or the counting house.',
  death: 'If you die you wake in the Temple of Ash with a grave chill. Your goods stay on your corpse for 30 minutes (only yours for the first 10): loot corpse to get them back, or pay Father Osmund to recover them. Banked coin is always safe.',
  corpses: 'loot corpse: take what a body carried.  take corpse: carry it (heavy).  give corpse to osmund in the nave (or drop it in the ossuary): a burial fee.  sell corpse to butcher: better paid, frowned upon.  bounty: collect cutpurse bounties at the watch house.',
  cart: 'The plague cart: when the bell in the temple tower tolls, get indoors or bank your coin. The cart takes the dead, the badly hurt, the passed out, and a quarter of what you carry. It comes at no fixed hour, every hour or two, and never leaves the town walls.',
  road: 'The north road: from the North Gate through the Moor Road, ten rooms north to the shut gate of Vesna. The forest lies all round it: the Edgewood, the Mere, the Falls, the Crags, the Blackwood, the Old Stones. Walk into the fog at the edge and you come back where you started. Brigands ask a toll at Brigand\'s Bend: pay, or fight.',
  shrine: 'The shrine, east of Mile Oak: purify at the water basin, then at the shrine offer 1, ring bell, bow, bow, clap, clap, pray, bow. Once a day it heals you fully and steadies your hand. draw fortune at the fortune tree (1 coin); tie fortune to leave a bad one behind. keep to the side in the red gates.',
  fishing: 'fish: cast where there is water worth fishing (the docks, the ford, the mere, the plunge pool, the sewer overflow). You need a rod from Maud and bait: dig for worms (dig) in soft wet ground, bread, or make bait. Sell fish to Bess at the fish market or Maud, or give them to Morda to cook.',
  crafting: 'recipes: what you can make.  make <thing>: bandage, torch, bait, campfire stew (at a fire), snare.  take stick in the forest.  set snare and check snare on rabbit runs in the Edgewood.  light torch, lamp or candle: dark places need a light.',
  gatherers: "The Gatherers' Hall, east off Butcher's Alley: join gatherers (1 coin), then deliver bodies to Warden Crane for pay by the body, more for fresh ones and for higher ranks. board: who wants which bodies this hour.",
  drink: 'Ale and gin at the Drowned Rat add up: merry (a little healing), tipsy (burps), drunk (slurred speech, wrong turns, worse aim, and Morda cuts you off), legless (out cold in the road, where thieves and the cart find you). Water, food and sleep sober you. health shows how drunk you are.',
  inn: "The Sleeping Lantern, south through the Rat's yard: rent bed (2 coin) or rent room (6 coin, with a chest), then sleep. A paid bed heals you to full and sobers you up. store <item> and retrieve <item> in your room. Type anything to wake.",
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
  combat: Combat;
  cart: PlagueCart;
  town: Town;
  wilds: Wilds;
  private townTimer: NodeJS.Timeout | null = null;
  private stockDay = '';

  constructor(
    public world: World,
    private brain: NpcBrain,
    private opts: {
      random?: () => number;
      scriptedDelayMs?: number;
      aiand?: LiveModel;
      ai?: Pick<AIService, 'status' | 'ping'>;
      combat?: { tickMs?: number; lifeMs?: number; streetFolk?: number };
      cart?: CartOptions;
      travelStepMs?: number;
      townMs?: number;
      wilds?: ConstructorParameters<typeof Wilds>[1];
    } = {},
  ) {
    this.catalog = new Catalog();
    this.catalog.load();
    this.commerce = new Commerce(this, this.catalog);
    this.combat = new Combat(this, opts.combat ?? {});
    this.cart = new PlagueCart(this, this.combat, opts.cart ?? {});
    this.town = new Town(this);
    this.wilds = new Wilds(this, opts.wilds ?? {});
  }

  /** Stocks the shops and fills their purses. Runs at start and again each new day. */
  async init(): Promise<void> {
    await restockShops(this.catalog);
    await this.town.init();
    this.stockDay = new Date().toISOString().slice(0, 10);
  }

  private rand(): number {
    return (this.opts.random ?? Math.random)();
  }

  /** The game's dice, so tests can load them. */
  random(): number {
    return this.rand();
  }

  startAmbient(): void {
    this.ambientTimer = setInterval(() => this.ambientTick(), AMBIENT_EVERY_MS);
    this.ambientTimer.unref();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_EVERY_MS);
    this.cleanupTimer.unref();
    this.startLife();
  }

  /** Fights, street folk and the plague cart. Separate so tests can run them without ambient chatter. */
  startLife(): void {
    this.combat.populate();
    this.combat.start();
    this.cart.start();
    this.townTimer = setInterval(() => void this.lifeBeat().catch((e) => console.error('town beat failed:', e)), this.opts.townMs ?? 20_000);
    this.townTimer.unref();
  }

  /** The slow beat outside fights: drink, sleep, lights, ambushes, the lamplighter, people talking. */
  async lifeBeat(): Promise<void> {
    await this.town.tick();
    this.wilds.tick();
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
    if (this.townTimer) clearInterval(this.townTimer);
    this.combat.stop();
    this.cart.stop();
  }

  // ---------------------------------------------------------------- connections

  async connect(conn: Connection, token?: string | null, cols?: number, keepScreen = false): Promise<Session> {
    const s = new Session(conn);
    if (cols) s.setCols(cols);
    this.sessions.add(s);

    const tok = token ? this.tokens.get(token) : undefined;
    if (tok && tok.expires > Date.now()) {
      const player = await this.loadPlayer(tok.playerId);
      if (player) {
        await this.enterWorld(s, player, true, false, keepScreen);
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
    this.stopTravel(s);
    this.stopBusy(s);
    this.sessions.delete(s);
    const lt = this.loginTimers.get(s);
    if (lt) clearTimeout(lt);
    this.loginTimers.delete(s);
    const p = s.player;
    s.state = 'closed';
    if (!p || this.byPlayer.get(p.id) !== s) return;
    this.byPlayer.delete(p.id);
    await query('UPDATE players SET last_seen=now(), room_id=$2 WHERE id=$1', [p.id, p.roomId]);
    await this.combat.save(p.id);

    // Dropping the connection mid fight doesn't save you: the body stays in the fight a while.
    const fighting = this.combat.inCombat(p.id);
    if (s.quitting && !fighting) {
      await this.combat.forget(p.id);
      this.toRoom(p.roomId, `${c.player(p.name)} fades into the fog.`);
      this.updateStatusAll();
      return;
    }
    // A dropped connection gets a short grace period before the room hears about it.
    const timer = setTimeout(() => {
      const ld = this.linkdead.get(p.id);
      this.linkdead.delete(p.id);
      void this.combat.forget(p.id).catch(() => undefined);
      this.toRoom(ld?.roomId ?? p.roomId, `${c.player(p.name)} fades into the fog.`);
      this.updateStatusAll();
    }, fighting ? 30_000 : LINKDEAD_GRACE_MS);
    timer.unref();
    this.linkdead.set(p.id, { timer, roomId: p.roomId, name: p.name });
  }

  /** The session playing this character right now, if any. */
  sessionOf(id: number): Session | undefined {
    return this.byPlayer.get(id);
  }

  /** Where a character is: online, or still standing there after dropping the connection. */
  playerRoom(id: number): string | null {
    return this.byPlayer.get(id)?.player?.roomId ?? this.linkdead.get(id)?.roomId ?? null;
  }

  setLinkdeadRoom(id: number, roomId: string): void {
    const ld = this.linkdead.get(id);
    if (ld) ld.roomId = roomId;
  }

  extraLoad(playerId: number): number {
    return this.combat.extraLoad(playerId);
  }

  refuseSale(s: Session, npc: Npc, templateId: string): string | null {
    return this.town.refuseSale(s, npc, templateId);
  }

  async giveToNpc(s: Session, npc: Npc, item: { id: number; template: { id: string; kind: string; name: string } }): Promise<boolean> {
    if (npc.id === 'morda' && (item.template.kind === 'fish' || item.template.kind === 'meat')) {
      await this.town.cook(s, item.id, this.catalog.template(item.template.id));
      return true;
    }
    return false;
  }

  async dropHere(s: Session, item: { id: number; template: { id: string } }): Promise<boolean> {
    if (s.player!.roomId !== 'barrow') return false;
    if (await this.wilds.blind(s)) return (s.out('It is too dark to see where you are putting anything.'), true);
    await this.wilds.leaveInBarrow(s, { id: item.id, template: this.catalog.template(item.template.id) });
    return true;
  }

  /** Something that takes a moment. Any command cuts it short. */
  busy(s: Session, ms: number, stop: string, then: () => Promise<void>): void {
    this.stopBusy(s);
    const timer = setTimeout(() => {
      s.busy = null;
      if (s.state !== 'playing') return;
      void then().catch((e) => console.error('busy task failed:', e));
    }, ms);
    timer.unref();
    s.busy = { timer, stop };
  }

  stopBusy(s: Session, say = false): void {
    if (!s.busy) return;
    clearTimeout(s.busy.timer);
    if (say) s.out(c.dim(s.busy.stop));
    s.busy = null;
  }

  onConsume(s: Session, t: Parameters<Combat['onConsume']>[1]): void {
    this.combat.onConsume(s, t);
  }

  gearLines(s: Session): Promise<string[]> {
    return this.combat.gearLines(s);
  }

  /** Every player in town hears it. */
  broadcast(text: string): void {
    for (const s of this.byPlayer.values()) s.out(text);
  }

  /** Puts a player somewhere without walking: thrown out, fled, or waking in the temple. */
  async placePlayer(s: Session, roomId: string, arrival: string): Promise<void> {
    const p = s.player!;
    this.commerce.closeHaggle(p.id);
    p.roomId = roomId;
    await query('UPDATE players SET room_id=$2 WHERE id=$1', [p.id, roomId]);
    this.visit(p.id, roomId);
    this.toRoom(roomId, arrival, s);
    await this.showRoom(s);
    this.updateStatus(s);
    this.combat.onArrive(s);
    await this.wilds.onArrive(s, null);
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
    const name = line.trim().normalize('NFC');
    if (!/^[\p{Script=Latin}]{3,16}$/u.test(name)) {
      s.out(c.error('Names are 3 to 16 letters, nothing else.'));
      return this.promptName(s);
    }
    if (RESERVED.has(nameKey(name))) {
      s.out(c.error('That name is taken by someone who was here first.'));
      return this.promptName(s);
    }
    s.pendingName = capitalize(name.toLowerCase());
    const { rows } = await query(
      'SELECT id FROM players WHERE name_key=$1 OR (name_key IS NULL AND lower(name)=lower($2))',
      [nameKey(name), name],
    );
    if (rows.length) {
      s.state = 'password';
      s.wrongPasswords = 0;
      s.conn.setMode({ echo: false, prompt: 'Password: ' });
      s.out(c.system(`Welcome back, ${s.pendingName}. Your password?`));
    } else {
      s.state = 'confirmNew';
      this.askNew(s);
    }
  }

  /** Spelled out, with buttons on phones: a stuck newcomer is a lost newcomer. */
  private askNew(s: Session, again = false): void {
    s.conn.setMode({
      echo: true,
      prompt: 'y or n: ',
      choices: [
        { label: 'Yes (y)', send: 'y' },
        { label: 'No (n)', send: 'n' },
      ],
    });
    if (again) {
      s.out(c.error(`Please choose yes (y) or no (n). Type y and press Enter to make ${s.pendingName}, or type n to pick a different name.`));
      return;
    }
    s.out(c.system(`No one in Gallowmere goes by ${s.pendingName} yet.`));
    s.out(c.system(`Make a new character called ${s.pendingName}? Please choose yes (y) or no (n): type y or n and press Enter.`));
  }

  private async onConfirmNew(s: Session, line: string): Promise<void> {
    const answer = line.trim().toLowerCase();
    // Only a clear yes or no moves on; anything else asks again.
    if (!['y', 'yes', 'n', 'no'].includes(answer)) return this.askNew(s, true);
    if (answer.startsWith('y')) {
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
        'INSERT INTO players (name, password_hash, room_id, name_key) VALUES ($1,$2,$3,$4) RETURNING id, name, room_id, created_at',
        [s.pendingName, hash, this.world.startRoom, nameKey(s.pendingName)],
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
    const { rows } = await query(
      'SELECT id, name, password_hash, room_id, created_at FROM players WHERE name_key=$1 OR (name_key IS NULL AND lower(name)=lower($2))',
      [nameKey(s.pendingName), s.pendingName],
    );
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
    keepScreen = false,
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
    await this.combat.load(player);
    this.visit(player.id, player.roomId);
    for (const id of KNOWN_FROM_START) this.visit(player.id, id);
    await this.town.gathererCount(player.id);

    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { playerId: player.id, expires: Date.now() + TOKEN_TTL_MS });
    s.conn.setToken(token);
    s.conn.setMode({ echo: true, prompt: '> ' });

    const quietly = resumed && (ld !== undefined || old !== undefined);
    if (resumed) s.out(c.dim('[Reconnected]'));
    if (!quietly && !old) this.toRoom(player.roomId, `${c.player(player.name)} steps out of the fog.`, s);
    // Coming back to a screen that still shows the game: no need to repeat the room.
    if (!(resumed && keepScreen)) await this.showRoom(s);
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
        const st = this.combat.state(p.id);
        s.conn.setStatus({
          name: p.name,
          room: room.title,
          online: this.byPlayer.size,
          exits: room.exits.filter((e) => !e.hidden).map((e) => e.direction),
          coin,
          health: st?.health,
          maxHealth: st ? maxHealthFor(st.level) : undefined,
        });
      })
      .catch(() => undefined);
  }

  private updateStatusAll(): void {
    for (const s of this.byPlayer.values()) this.updateStatus(s);
  }

  async showRoom(s: Session): Promise<void> {
    const room = this.world.room(s.player!.roomId);
    if (await this.wilds.blind(s)) {
      s.out(c.title(room.title));
      s.out('It is too dark to see. Something moves, or doesn\'t. You would need a light.');
      const back = room.exits.filter((e) => !e.hidden).map((e) => e.direction);
      return s.out(c.exits(`You can feel your way: ${back.join(', ')}.`));
    }
    const floor = await this.commerce.roomItems(room.id);
    s.out(c.title(room.title));
    s.out(room.description);
    // Who and what is here, one scannable line each. Every name can be clicked to look at it.
    const npcs = this.world.npcsIn(room.id).map((n) => n.card.listName ?? n.name);
    const players = this.playersIn(room.id, s).map((p) => p.player!.name);
    const things = [...room.features.map((f) => f.name), ...groupNames(floor), ...(await this.combat.corpseNames(room.id))];
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

  async command(s: Session, line: string, retried = false): Promise<void> {
    if (!line) return;
    if (s.travelling && !retried) this.stopTravel(s, 'You stop walking.');
    if (s.busy && !retried) this.stopBusy(s, true);
    // A habit from chat apps: "/wave" means wave.
    line = line.replace(/^\/(?=[a-z])/i, '');
    line = this.expandAlias(s, line);
    const me = this.combat.state(s.player!.id);
    if (me && this.town.isOut(me) && !/^(quit|exit|logout|health|hp|score|sc|help)\b/i.test(line)) {
      return s.out(c.dim('You are out cold in the road. The world can wait. It will have to.'));
    }
    if (me?.asleep && !retried) {
      this.town.wake(s);
      if (/^(wake|stand|get up)\b/i.test(line)) return;
    }

    if (line.startsWith("'") || line.startsWith('"')) return this.say(s, line.slice(1).trim());
    if (line.startsWith(':')) return this.emote(s, line.slice(1).trim());

    const [verbRaw, ...restParts] = line.split(' ');
    const verb = verbRaw.toLowerCase();
    let rest = restParts.join(' ').trim();

    if (DIR_SHORT[verb]) return void (await this.move(s, DIR_SHORT[verb]));

    switch (verb) {
      case 'l':
      case 'look':
      case 'examine':
      case 'x': {
        if (!rest) return this.look(s, rest);
        if (await this.combat.lookCorpse(s, rest)) return;
        const target = await this.resolveTarget(s, rest);
        return target === null ? undefined : this.look(s, target);
      }
      case 'go':
        if (DIR_SHORT[rest.toLowerCase()]) return void (await this.move(s, DIR_SHORT[rest.toLowerCase()]));
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
      case 'bye':
      case 'goodbye':
      case 'farewell':
      case 'thanks':
      case 'thank':
      case 'cheers':
        // A bare greeting is spoken out loud: "hi guard" says "hi guard".
        return this.say(s, line);
      case 'attack':
      case 'kill':
      case 'hit':
      case 'fight':
      case 'punch':
      case 'stab':
      case 'k':
        return this.combat.attack(s, rest);
      case 'flee':
      case 'run':
        return this.combat.flee(s);
      case 'consider':
      case 'con':
        return this.combat.consider(s, rest);
      case 'wield':
        return this.combat.wield(s, rest);
      case 'wear':
        return this.combat.wear(s, rest);
      case 'remove':
      case 'unwield':
        return this.combat.remove(s, rest);
      case 'bandage':
        return this.combat.bandage(s);
      case 'travel':
      case 'walk':
      case 'goto':
        if (verb === 'walk' && /^away/i.test(rest)) return this.commerce.walkAway(s);
        return this.travel(s, rest.replace(/^to\s+/i, ''));
      case 'journal':
      case 'j':
      case 'notes':
      case 'notebook':
      case 'places':
        return this.journal(s);
      case 'stop':
        return s.travelling ? undefined : s.out("You're standing still already.");
      case 'crush':
      case 'break':
        if (/token/i.test(rest)) return this.useToken(s);
        if (/charm|fox/i.test(rest)) return this.useCharm(s);
        break;
      case 'health':
      case 'hp':
      case 'body':
      case 'diagnose':
      case 'condition':
        return this.combat.diagnose(s);
      case 'fish':
      case 'cast':
        return this.wilds.fish(s);
      case 'dig':
        return this.wilds.dig(s);
      case 'make':
      case 'craft':
        return this.wilds.make(s, rest);
      case 'recipes':
      case 'recipe':
        return this.wilds.recipes(s);
      case 'set':
        if (/snare|trap/i.test(rest)) return this.wilds.setSnare(s);
        break;
      case 'purify':
      case 'rinse':
        return this.wilds.purify(s);
      case 'bow':
      case 'clap':
      case 'pray':
        // At the shrine these are the ritual; anywhere else they are just manners.
        if (s.player!.roomId === 'shrine') return this.wilds.step(s, verb as 'bow' | 'clap' | 'pray');
        return this.social(s, verb, rest);
      case 'emotes':
      case 'socials':
        return this.listSocials(s);
      case 'follow':
        if (/fox/i.test(rest)) return this.wilds.followFox(s);
        return s.out('Follow whom?');
      case 'keep':
      case 'side':
        return this.wilds.keepSide(s);
      case 'draw':
        if (/fortune|lot|stick/i.test(rest)) return this.wilds.drawFortune(s);
        break;
      case 'tie':
        if (/fortune|slip|paper|curse/i.test(rest)) return this.wilds.tieFortune(s);
        return s.out('Tie what?');
      case 'pay':
        return this.wilds.pay(s);
      case 'ferry':
      case 'row':
      case 'boat':
        return this.wilds.ferry(s);
      case 'join':
        if (/gather|guild/i.test(rest) || !rest) return this.town.join(s);
        break;
      case 'deliver':
        return this.town.deliver(s);
      case 'board':
      case 'wanted':
        return this.town.board(s);
      case 'rent':
        return this.town.rent(s, rest);
      case 'sleep':
      case 'nap':
        return this.town.sleep(s);
      case 'wake':
        return s.out("You're awake. Mostly.");
      case 'store':
      case 'stash':
        return this.town.store(s, rest);
      case 'retrieve':
      case 'chest':
        return this.town.retrieve(s, rest);
      case 'loot':
        return this.combat.loot(s, rest);
      case 'bounty':
      case 'bounties':
        return this.combat.bounty(s);
      case 'heal':
        return this.combat.heal(s);
      case 'recover':
        return this.combat.recover(s);
      case 'bury':
        return this.combat.bury(s);
      case 'emote':
      case 'me':
        return this.emote(s, rest);
      case 'i':
      case 'inv':
      case 'inventory':
        return this.commerce.inventory(s);
      case 'drop':
        if (await this.combat.dropCorpse(s, rest)) return;
        return this.commerce.drop(s, rest);
      case 'give':
      case 'hand':
        if (this.combat.mentionsCorpse(rest)) {
          if (/\bcrane|warden\b/i.test(rest)) return this.town.deliver(s);
          return /\bosmund|priest|father\b/i.test(rest) ? this.combat.bury(s) : s.out("Father Osmund buries the dead, the butcher buys them, and Warden Crane at the Gatherers' Hall pays best.");
        }
        return this.commerce.give(s, rest);
      case 'list':
      case 'wares':
        return this.commerce.list(s);
      case 'buy':
      case 'purchase':
        return this.commerce.buy(s, rest);
      case 'sell':
        if (this.combat.mentionsCorpse(rest)) return s.player!.roomId === 'gatherers_hall' ? this.town.deliver(s) : this.combat.sellToButcher(s);
        return this.commerce.sell(s, rest);
      case 'offer':
        if (s.player!.roomId === 'shrine') return this.wilds.step(s, 'offer', Number(rest.match(/\d+/)?.[0] ?? 1));
        return this.commerce.offer(s, rest);
      case 'counter':
        return this.commerce.offer(s, rest);
      case 'accept':
      case 'deal':
        return this.commerce.accept(s);
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
      case 'aibench':
        if (this.isAdmin(s)) return this.aiBench(s, rest);
        break;
      case 'aimodel':
        if (this.isAdmin(s)) return this.aiModel(s, rest);
        break;
      case 'ring':
        // The admin ringing the bell in the tower sends the cart out; anyone else just makes noise.
        if (this.isAdmin(s) && s.player!.roomId === 'bell_tower' && /bell/i.test(rest)) return this.ringForCart(s);
        if (s.player!.roomId === 'shrine' && (!rest || /bell|rope/i.test(rest))) return this.wilds.step(s, 'ring');
        break;
      case 'aiping':
        if (this.isAdmin(s)) return this.aiPing(s);
        break;
      case 'cart':
        if (this.isAdmin(s)) return this.ringForCart(s);
        break;
    }
    if (SOCIALS[verb]) return this.social(s, verb, rest);
    if (VERBS[verb]) {
      const action = VERBS[verb];
      if (action === 'light' && rest && (await this.wilds.light(s, rest))) return;
      if (verb === 'check' && /snare|trap/i.test(rest)) return this.wilds.checkSnare(s);
      if (action !== 'light' && (await this.wilds.blind(s))) {
        const mineOnly = ['eat', 'drink', 'use', 'read', 'smell'].includes(action) && rest && (await this.commerce.itemAction(s, action, rest));
        if (mineOnly) return;
        return s.out('It is too dark to see anything. You would need a light.');
      }
      if (action === 'take' && /^(a |some |up )?(sticks?|branch(es)?|deadwood)$/i.test(rest.trim()) && (await this.wilds.takeStick(s))) return;
      if (action === 'take' && s.player!.roomId === 'barrow' && /torc|gold/i.test(rest)) return this.wilds.takeTorc(s);
      if (action === 'take' && s.player!.roomId === 'fox_grove' && /fire|light|bowl/i.test(rest)) return this.wilds.takeFoxFire(s);
      if (action === 'search' && s.player!.roomId === 'behind_falls' && /bed|straw|pallet|cloak|pilgrim|skeleton|pocket|body/i.test(rest)) return this.wilds.searchFalls(s);
      if (rest && !/^all\b/i.test(rest)) {
        const target = await this.resolveTarget(s, rest);
        if (target === null) return;
        rest = target;
      }
      // Your own things first, then things on the floor, then the room.
      if (action === 'use' && /token/i.test(rest)) return this.useToken(s);
      if (action === 'take' && rest && (await this.combat.takeCorpse(s, rest))) return;
      if (action === 'take' && rest && (await this.commerce.take(s, rest))) return;
      if (['eat', 'drink', 'light', 'read', 'use', 'open', 'smell'].includes(action) && (await this.commerce.itemAction(s, action, rest))) return;
      return this.interact(s, action, verb, rest);
    }
    // One small slip in a harmless command ("lok", "aks", "inventroy") is read as what was meant.
    const fix = retried ? null : forgiveCommand(verb);
    if (fix) return this.command(s, rest ? `${fix} ${rest}` : fix, true);
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

  private async move(s: Session, dir: Direction, brief = false): Promise<boolean> {
    const p = s.player!;
    const room = this.world.room(p.roomId);
    const st = this.combat.state(p.id);
    if (st?.target) return (s.out(c.error("You're in a fight! Flee if you want out.")), false);
    if (!room.exits.some((e) => e.direction === dir)) {
      const fog = this.wilds.fogEdge(room);
      return (s.out(fog ?? "You can't go that way."), false);
    }
    // Drunk feet go where they like.
    dir = (this.town.wrongTurn(s, dir) as Direction | null) ?? dir;
    const exit = room.exits.find((e) => e.direction === dir)!;
    const gate = await this.wilds.canEnter(s, room, exit);
    if (gate === 'handled') return false;
    if (gate) return (s.out(gate), false);
    const lock = room.locks[dir];
    if (lock) {
      const mine = await this.commerce.myItems(s);
      if (mine.some((i) => i.template.id === lock.key)) s.out(c.system(lock.unlock));
      else if ((st?.level ?? 1) >= lock.force) s.out(c.system(lock.forced));
      else return (s.out(lock.locked), false);
    }
    this.commerce.closeHaggle(p.id);
    this.toRoom(room.id, `${c.player(p.name)} leaves ${dir}.`, s);
    p.roomId = exit.to;
    await query('UPDATE players SET room_id=$2 WHERE id=$1', [p.id, p.roomId]);
    const from = OPPOSITE[dir];
    const fromText = from === 'up' ? 'above' : from === 'down' ? 'below' : `the ${from}`;
    this.toRoom(p.roomId, `${c.player(p.name)} arrives from ${fromText}.`, s);
    this.visit(p.id, p.roomId);
    if (brief) await this.showRoomBrief(s);
    else await this.showRoom(s);
    this.updateStatus(s);
    this.combat.onArrive(s);
    await this.wilds.onArrive(s, room.id);
    return true;
  }

  /** Remembers that this character has been here, for travel. */
  private visit(playerId: number, roomId: string): void {
    void query('INSERT INTO visited_rooms (player_id, room_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [playerId, roomId]).catch(() => undefined);
  }

  /** On the way somewhere: the room's name and who's in it, nothing more. */
  private async showRoomBrief(s: Session): Promise<void> {
    const room = this.world.room(s.player!.roomId);
    const npcs = this.world.npcsIn(room.id).map((n) => n.card.listName ?? n.name);
    const players = this.playersIn(room.id, s).map((p) => p.player!.name);
    s.out(c.title(room.title) + (npcs.length || players.length ? c.dim(`  (${[...npcs, ...players].join(', ')})`) : ''));
  }

  stopTravel(s: Session, why?: string): void {
    if (!s.travelling) return;
    clearTimeout(s.travelling);
    s.travelling = null;
    if (why) s.out(c.dim(why));
  }

  /**
   * travel <place>: walks you to somewhere you've been before, one room at a time. The streets are
   * still the streets: a fight, the cart or any command you type stops you.
   */
  private async travel(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const { rows } = await query('SELECT room_id FROM visited_rooms WHERE player_id=$1', [p.id]);
    const known = rows.map((r) => r.room_id as string).filter((id) => this.world.rooms.has(id));
    const t = cleanTarget(rest);
    if (!t) {
      const names = known.map((id) => this.world.room(id).title).sort();
      s.out(c.title('Places you know the way to:'));
      s.out(names.length ? names.join(', ') : 'Nowhere yet. Walk about first.');
      return s.out(c.dim('travel <place>, for example: travel nave, travel tavern, travel bank.'));
    }
    const ALIAS: Record<string, string> = {
      tavern: 'drowned_rat', rat: 'drowned_rat', inn: 'sleeping_lantern', pub: 'drowned_rat', bar: 'drowned_rat', morda: 'drowned_rat',
      bank: 'counting_house', temple: 'nave', church: 'nave', osmund: 'nave', priest: 'nave', heal: 'nave',
      gate: 'north_gate', smith: 'smithy_row', smithy: 'smithy_row', hamo: 'smithy_row', blacksmith: 'smithy_row', maud: 'maud_shop', grocer: 'maud_shop',
      tilly: 'curio_shop', pawn: 'curio_shop', hook: 'hook_den', fence: 'hook_den', butcher: 'butchers_alley',
      watch: 'watch_house', bounty: 'watch_house', market: 'market_square', docks: 'river_docks', sewer: 'sewer_grate',
      lantern: 'sleeping_lantern', peg: 'sleeping_lantern', bed: 'sleeping_lantern', sleep: 'sleeping_lantern', hotel: 'sleeping_lantern',
      gatherers: 'gatherers_hall', guild: 'gatherers_hall', hall: 'gatherers_hall', crane: 'gatherers_hall',
      shrine: 'shrine', keeper: 'shrine', fortune: 'fortune_tree', oak: 'mile_oak', ford: 'drovers_ford', mere: 'mere_shore', lake: 'mere_shore',
      jetty: 'mere_jetty', ferry: 'mere_jetty', ferryman: 'mere_jetty', falls: 'falls_pool', waterfall: 'falls_pool', crags: 'crag_scree',
      vesna: 'shut_gate', waystation: 'burnt_waystation', clearing: 'ew_clearing', cole: 'ew_clearing', charcoal: 'ew_clearing',
      bend: 'brigands_bend', camp: 'camp_tents', stones: 'stone_ring', fish: 'fish_market', bess: 'fish_market',
    };
    let dest = ALIAS[t] && known.includes(ALIAS[t]) ? ALIAS[t] : undefined;
    if (!dest) {
      const hit = looseMatch(rest, known.map((id) => ({ name: this.world.room(id).title, keywords: id.split('_'), ref: id })));
      if (hit && 'ambiguous' in hit) return s.out(`Which do you mean: ${orList(hit.ambiguous).replace(/ and (?!.* and )/, ' or ')}?`);
      dest = hit && 'ref' in hit ? hit.ref : undefined;
    }
    if (!dest) {
      // A real place you haven't found yet, or nowhere at all?
      const all = [...this.world.rooms.values()].map((r) => ({ name: r.title, keywords: r.id.split('_'), ref: r.id }));
      const real = ALIAS[t] || looseMatch(rest, all);
      return s.out(real ? "You don't know the way there yet. Find it on foot once." : "You don't know anywhere by that name.");
    }
    if (dest === p.roomId) return s.out("You're already there.");
    if (this.combat.state(p.id)?.target) return s.out(c.error("You're in a fight! Flee first."));
    // A hidden way counts once you've been through to the other side.
    const route = this.world.path(p.roomId, dest, (e) => known.includes(e.to));
    if (!route) return s.out("You can't work out a way there from here.");
    this.stopTravel(s);
    s.out(c.system(`You set off for ${this.world.room(dest).title}, ${route.length} step${route.length > 1 ? 's' : ''} away. Type anything to stop.`));
    const step = async (i: number) => {
      s.travelling = null;
      if (s.state !== 'playing' || s.player !== p) return;
      const ok = await this.move(s, route[i] as Direction, i < route.length - 1);
      if (!ok) return s.out(c.dim('You stop.'));
      if (i === route.length - 1) return;
      s.travelling = setTimeout(() => void step(i + 1).catch(() => undefined), this.opts.travelStepMs ?? 1200);
      s.travelling.unref();
    };
    await step(0);
  }

  /** Admin: ring the temple bell and send the plague cart out now. Only from the bell tower. */
  private ringForCart(s: Session): void {
    if (s.player!.roomId !== 'bell_tower') return s.out('The bell hangs in the bell tower, up the ladder from the nave. Ring it from there.');
    if (this.cart.out) return s.out('The cart is already out.');
    s.out(c.dim('You haul on the rope with both hands.'));
    this.toRoom(s.player!.roomId, `${c.player(s.player!.name)} hauls on the bell rope.`, s);
    this.cart.bell();
  }

  /** journal: the places you've found that are worth going back to. */
  private async journal(s: Session): Promise<void> {
    const p = s.player!;
    const { rows } = await query('SELECT room_id FROM visited_rooms WHERE player_id=$1', [p.id]);
    const been = new Set(rows.map((r) => r.room_id as string));
    const found = JOURNAL.filter((e) => been.has(e.room) && this.world.rooms.has(e.room));
    s.out(c.title('Your notebook'));
    s.out(c.dim('Tucked inside the cover, a note in a cramped, tired hand:'));
    for (const line of OSMUND_NOTE) s.out(c.dim(`  ${line}`));
    s.out('');
    if (!found.length) {
      s.out("A few blank pages. Walk about and you'll fill them.");
      return;
    }
    let group = '';
    for (const e of found.sort((a, b) => JOURNAL.findIndex((x) => x.group === a.group) - JOURNAL.findIndex((x) => x.group === b.group))) {
      if (e.group !== group) {
        group = e.group;
        s.out(c.label(group));
      }
      // "Father Osmund: heal..." reads as "The Nave (Father Osmund): heal...".
      const m = e.note.match(/^([A-Z][^:]{0,24}): (.*)$/);
      const who = m ? ` (${m[1]})` : '';
      s.out(`  ${c.thing(this.world.room(e.room).title)}${who}: ${m ? m[2] : e.note}. ${c.dim(`travel ${e.travel}`)}`);
    }
    const others = [...been].filter((id) => this.world.rooms.has(id) && !JOURNAL.some((e) => e.room === id)).length;
    const missing = JOURNAL.filter((e) => !been.has(e.room)).length;
    s.out(c.dim(`And ${others} other place${others === 1 ? '' : 's'} you know the way to (travel on its own lists them all).${missing ? ' Some pages are still blank.' : ''}`));
  }

  /** Crush a fox charm: back to the forest shrine. */
  private async useCharm(s: Session): Promise<void> {
    const p = s.player!;
    const charm = (await this.commerce.myItems(s)).find((i) => i.template.id === 'fox_charm');
    if (!charm) return s.out("You don't have a fox charm. The shrine keeper sells them.");
    if (this.combat.inCombat(p.id)) return s.out(c.error("You can't, not with someone at your throat. Flee first."));
    if (p.roomId === 'shrine') return s.out("You're at the shrine already.");
    const ok = await tx((cl) => deleteItem(cl, charm.id, { type: 'player', id: p.id }));
    if (!ok) return;
    this.stopTravel(s);
    s.out(c.system('You crush the little wooden fox in your fist. You hear, very close, a fox bark once, and the world turns red at the edges like a row of gates going by, and you are standing before the shrine.'));
    this.toRoom(p.roomId, `${c.player(p.name)} crushes something small and is gone, and a fox barks somewhere.`, s);
    this.visit(p.id, 'shrine');
    await this.placePlayer(s, 'shrine', `${c.player(p.name)} is suddenly standing before the shrine.`);
  }

  /**
   * Two characters in a room trade a line or two while a player listens. Light, no memory, and
   * nothing at all if the AI is not there: canned lines would only repeat.
   */
  async npcBanter(a: Npc, b: Npc, topic: string, listener: Session): Promise<void> {
    if (listener.aiPending || !listener.player) return;
    const roomId = a.roomId;
    const line = async (who: Npc, to: Npc, said: string, kind: 'say' | 'event') => {
      const card = who.card as any;
      return this.brain.turn({
        npcId: who.id,
        npc: { name: who.name, job: card.job, personality: card.personality, speech: card.speech, wants: card.wants, knows: card.knows, quirks: card.quirks, scripted: card.scripted, light: true },
        player: { id: listener.player!.id, name: to.name },
        memory: { notes: [], summary: '' },
        room: { title: this.world.room(roomId).title, others: [listener.player!.name], note: this.cart.note() },
        recent: [],
        playerLine: said,
        kind,
        allowedActions: ['none'],
      });
    };
    listener.aiPending = true;
    try {
      const first = await line(a, b, `is beside you. Turn and say one short line to ${b.name} about ${topic}`, 'event');
      if (first.source === 'scripted' || !first.say || a.roomId !== roomId) return;
      const nameA = capitalize((a.card.speaker as string | undefined) ?? a.name);
      const nameB = capitalize((b.card.speaker as string | undefined) ?? b.name);
      this.toRoom(roomId, `${c.npc(nameA)} says to ${c.npc(b.name)}, ${c.speech(`"${first.say}"`)}`);
      const second = await line(b, a, first.say, 'say');
      if (second.source === 'scripted' || !second.say || b.roomId !== roomId) return;
      this.toRoom(roomId, `${c.npc(nameB)} says to ${c.npc(a.name)}, ${c.speech(`"${second.say}"`)}`);
    } finally {
      listener.aiPending = false;
    }
  }

  /** Crush a pilgrim's token: back to the nave at once, unless someone has you by the throat. */
  private async useToken(s: Session): Promise<void> {
    const p = s.player!;
    const mine = await this.commerce.myItems(s);
    const token = mine.find((i) => i.template.id === 'pilgrim_token');
    if (!token) return s.out("You don't have a pilgrim's token. Father Osmund sells them in the nave.");
    if (this.combat.inCombat(p.id)) return s.out(c.error("You can't, not with someone at your throat. Flee first."));
    if (p.roomId === 'nave') return s.out("You're already in the nave. Save it.");
    const ok = await tx((cl) => deleteItem(cl, token.id, { type: 'player', id: p.id }));
    if (!ok) return;
    this.stopTravel(s);
    s.out(c.system('You crush the token in your fist and say the words. The street tilts, the light goes grey, and you are kneeling on the cold floor of the nave.'));
    this.toRoom(p.roomId, `${c.player(p.name)} crushes something in one fist and is simply gone.`, s);
    this.visit(p.id, 'nave');
    await this.placePlayer(s, 'nave', `${c.player(p.name)} is suddenly kneeling on the floor of the nave, gasping.`);
  }



  async look(s: Session, target: string): Promise<void> {
    const t = cleanTarget(target);
    if (!t) return await this.showRoom(s);
    if (await this.wilds.blind(s)) {
      if (await this.commerce.lookItem(s, target)) return;
      return s.out('It is too dark to see that.');
    }
    const roomId = s.player!.roomId;
    if (t === 'me' || t === 'self' || t === 'myself' || nameKey(t) === nameKey(s.player!.name)) {
      s.out('You look like someone who just walked out of the fog. Damp, mostly.');
      return this.combat.diagnose(s);
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
    if (['me', 'self', 'myself'].includes(t) || nameKey(t) === nameKey(p.name)) return rest;
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
    return this.playersIn(s.player!.roomId, s).find((o) => nameKey(o.player!.name).startsWith(nameKey(first)));
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
        const witness = this.world.npcsIn(p.roomId).find((n) => n.kind === 'ai') ?? this.world.npcsIn(p.roomId).find((n) => n.kind === 'light');
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
      if (npc.kind !== 'scripted') void this.npcRespond(s, npc, `${theirs} you`, 'event');
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
    text = this.town.speech(s, text);
    s.out(`You say, ${c.speech(`"${text}"`)}`);
    this.toRoom(p.roomId, `${c.player(p.name)} says, ${c.speech(`"${text}"`)}`, s);

    // Naming someone in the room counts as talking to them. AI characters win a tie.
    const npc =
      this.mentionedNpc(p.roomId, text) ??
      this.looselyAddressed(p.roomId, text) ??
      this.conversationPartner(s, text) ??
      this.onlyListener(s);
    if (npc) return void this.respondOrHaggle(s, npc, text);
    this.overheard(s);
  }

  /** Alone with one person, whatever you say is said to them. */
  private onlyListener(s: Session): Npc | undefined {
    const p = s.player!;
    if (this.playersIn(p.roomId, s).length) return undefined;
    const npcs = this.world.npcsIn(p.roomId);
    return npcs.length === 1 ? npcs[0] : undefined;
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

  /** Several people here and none of them named: one of them reacts, now and then. */
  private overheard(s: Session): void {
    const p = s.player!;
    const npcs = this.world.npcsIn(p.roomId).filter((n) => !n.card.mute);
    if (npcs.length < 2 || this.playersIn(p.roomId, s).length) return;
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
   * Mid conversation, a plain say carries on talking to the same character,
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
    return hits.find((n) => n.kind === 'ai') ?? hits.find((n) => n.kind === 'light') ?? hits[0];
  }

  /** wave, laugh, bow and the rest: alone, or at someone here, who may react. */
  private social(s: Session, verb: string, rest: string): void {
    const social = SOCIALS[verb];
    const p = s.player!;
    const t = cleanTarget(rest.replace(/^(at|to|for|with|before)\s+/i, ''));
    if (!t || social.to === undefined) {
      const lines = socialLines(social, p.name);
      s.out(lines.mine);
      return this.toRoom(p.roomId, `${c.player(p.name)} ${lines.room.slice(p.name.length + 1)}`, s);
    }
    const npc = this.world.findNpc(p.roomId, t);
    const other = npc ? undefined : this.findPlayerHere(s, t);
    if (!npc && !other) {
      // "hug bob", "wave at bob" or a lone word like "wave bobby" means a person: say they aren't here.
      const word = rest.trim();
      const aimed = social.to === '' || /^(at|to|for|with|before)\s+/i.test(word) || (/^\S+$/.test(word) && !/ly$/i.test(word));
      if (aimed) return s.out(`You don't see ${t} here.`);
      // Otherwise take it as how you do it. "dance wildly".
      const how = sanitize(rest, 80);
      if (this.blockIfFlagged(s, how)) return;
      s.out(`You ${social.you} ${how}.`);
      return this.toRoom(p.roomId, `${c.player(p.name)} ${social.they} ${how}.`, s);
    }
    const name = npc ? (npc.card.listName ?? npc.name) : other!.player!.name;
    const lines = socialLines(social, p.name, name);
    s.out(lines.mine);
    if (other) other.out(`${c.player(p.name)} ${lines.theirs!.slice(p.name.length + 1)}`);
    this.toRoom(p.roomId, `${c.player(p.name)} ${lines.room.slice(p.name.length + 1)}`, s, other);
    if (npc) {
      if (npc.kind === 'scripted') void this.npcRespond(s, npc, verb);
      else void this.npcRespond(s, npc, socialEvent(social), 'event');
    }
  }

  private listSocials(s: Session): void {
    s.out(c.title('Emotes'));
    s.out(Object.keys(SOCIALS).sort().join(', '));
    s.out(c.dim('Alone, or at someone here: wave, wave morda, laugh at bob, hug tilly. For anything else: emote <words>.'));
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
    text = this.town.speech(s, text);
    s.out(`You say to ${c.npc(npc.name)}, ${c.speech(`"${text}"`)}`);
    this.toRoom(p.roomId, `${c.player(p.name)} says to ${c.npc(npc.name)}, ${c.speech(`"${text}"`)}`, s);
    void this.respondOrHaggle(s, npc, text);
  }

  /**
   * "ask tilly who runs the docks?", "ask old tilly about the heron", or just "ask who runs the docks?"
   * when there's only one person to ask. A question is passed on word for word.
   */
  private ask(s: Session, rest: string): void {
    const p = s.player!;
    const words = rest.replace(/^(to|the)\s+/i, '').trim().split(' ').filter(Boolean);
    if (!words.length) return s.out('Ask whom what? Try: ask tilly about the heron, or ask tilly who runs the docks?');

    // Whoever the opening words name: "old tilly", "tilly," or a near miss like "tily".
    let npc: Npc | undefined;
    let used = 0;
    const here = this.world.npcsIn(p.roomId);
    const bare = (w: string) => w.toLowerCase().replace(/[,:;.!?]+$/, '');
    for (let n = Math.min(3, words.length); n >= 1 && !npc; n--) {
      const phrase = words.slice(0, n).map(bare).join(' ');
      npc = here.find((x) => [x.name, x.card.listName, ...x.card.keywords].some((k) => k && k.toLowerCase() === phrase));
      if (npc) used = n;
    }
    if (!npc) {
      const hit = looseMatch(bare(words[0]), here.map((x) => ({ name: x.name, keywords: [x.name, ...x.card.keywords].filter((k) => !k.includes(' ')), ref: x })));
      if (hit && 'ref' in hit) {
        npc = hit.ref;
        used = 1;
      }
    }
    // No name: the person you're talking to, or the only one here.
    if (!npc) npc = this.conversationPartner(s, rest) ?? this.onlyListener(s);
    if (!npc) {
      return s.out(here.length > 1 ? `Ask whom? Name them: ask ${here[0].card.keywords[0]} ...` : "There's nobody here to ask.");
    }

    const rem = words.slice(used).join(' ').replace(/^[,:;]\s*/, '').trim();
    const who = capitalize(npc.card.listName ?? npc.name);
    if (!rem) return s.out(`Ask ${who} what?`);
    if (this.blockIfFlagged(s, rem)) return;
    const about = rem.match(/^about\s+(.+)$/i);
    if (about) {
      const topic = about[1].replace(/[?.!]+$/, '');
      s.out(`You ask ${c.npc(who)} about ${topic}.`);
      this.toRoom(p.roomId, `${c.player(p.name)} asks ${c.npc(who)} about ${topic}.`, s);
      return void this.respondOrHaggle(s, npc, `What can you tell me about ${topic}?`);
    }
    s.out(`You ask ${c.npc(who)}, ${c.speech(`"${rem}"`)}`);
    this.toRoom(p.roomId, `${c.player(p.name)} asks ${c.npc(who)}, ${c.speech(`"${rem}"`)}`, s);
    void this.respondOrHaggle(s, npc, rem);
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
      const line = this.brain.scripted(npc.id, npc.card as { scripted: string[]; replies?: Replies }, kind === 'say' ? playerLine : undefined);
      if (kind === 'say') this.chatting.set(p.id, { npcId: npc.id, at: Date.now() });
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
      // Light characters talk freely but keep nothing: no notes, no standing, no actions.
      const light = npc.kind === 'light';
      const memory = light ? { notes: [], summary: '' } : await getMemory(npc.id, p.id);
      const others = [
        ...this.playersIn(roomId, s).map((o) => o.player!.name),
        ...this.world.npcsIn(roomId).filter((n) => n.id !== npc.id).map((n) => n.name),
      ];
      const card = npc.card as any;
      const allowed: ActionType[] = light ? ['none'] : ['none', 'remember', 'refuse', ...(trade ? TRADE_ACTIONS : [])];
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
          quirks: card.quirks,
          tradeStyle: card.tradeStyle,
          scripted: card.scripted,
          replies: card.replies,
          light,
          mute: !!card.mute,
        },
        player: { id: p.id, name: p.name },
        memory,
        room: { title: this.world.room(roomId).title, others, note: [this.cart.note(), this.town.noteFor(npc, p.id)].filter(Boolean).join(' ') || undefined },
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

      // "the butcher" opens a sentence as "The butcher".
      const who = capitalize((card.speaker as string | undefined) ?? npc.name);
      if (out.emote) {
        const names = [npc.name, card.speaker, card.listName].filter(Boolean).map((n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        let emote = out.emote.replace(new RegExp(`^(${names.join('|')})\\s+`, 'i'), '');
        if (!/[.!?"]$/.test(emote)) emote += '.';
        this.toRoom(roomId, c.npc(`${who} ${emote}`));
        if (!out.say) this.pushRecent(key, `(${npc.name} ${emote})`);
      }
      if (out.say) {
        for (const o of this.playersIn(roomId)) {
          const to = o === s ? 'you' : p.name;
          o.out(`${c.npc(who)} says to ${to}, ${c.speech(`"${out.say}"`)}`);
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
      this.toRoom(roomId, c.npc(this.brain.scripted(npc.id, npc.card as { scripted: string[]; replies?: Replies }, kind === 'say' ? playerLine : undefined)));
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
    for (const o of list) {
      const title = this.town.title(o.id);
      s.out(`  ${c.player(o.name.padEnd(16))} ${c.dim(this.world.room(o.roomId).title)}${title ? c.dim(`, ${title}`) : ''}`);
    }
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
    const alias: Record<string, string> = {
      emotes: 'emote', socials: 'emote', wave: 'emote', laugh: 'emote',
      attack: 'fight', kill: 'fight', flee: 'fight', combat: 'fight', die: 'death', dead: 'death', corpse: 'corpses', loot: 'corpses', bounty: 'corpses', plague: 'cart', bell: 'cart',
      forest: 'road', north: 'road', brigands: 'road', vesna: 'road', fog: 'road', fish: 'fishing', rod: 'fishing', bait: 'fishing', worms: 'fishing',
      make: 'crafting', craft: 'crafting', recipes: 'crafting', snare: 'crafting', torch: 'crafting', dark: 'crafting', light: 'crafting',
      guild: 'gatherers', deliver: 'gatherers', board: 'gatherers', ale: 'drink', gin: 'drink', drunk: 'drink', sleep: 'inn', bed: 'inn', rent: 'inn', chest: 'inn',
      fortune: 'shrine', pray: 'shrine', ritual: 'shrine',
    };
    const key = DIR_SHORT[t] ? 'move' : t === 'l' ? 'look' : alias[t] ?? t;
    if (key && HELP[key]) return s.out(HELP[key]);
    s.out(c.title('Commands'));
    for (const line of Object.values(HELP)) s.out(`  ${line}`);
    if (this.isAdmin(s)) {
      s.out('  aistats: AI calls, latency and fallbacks per player, last 24 hours.');
      s.out('  aibench [models | model ...]: time the same chat with Tilly on ai& models.');
      s.out('  aimodel [model]: show or switch the ai& model until restart.');
      s.out('  aiping: one tiny request to each AI provider, to see which work.');
      s.out('  cart (or ring bell): in the bell tower, up the ladder from the nave, ring the bell and send the plague cart out now.');
    }
  }

  private async score(s: Session): Promise<void> {
    const p = s.player!;
    const days = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86_400_000);
    const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    s.out(`You are ${c.player(p.name)}, who came out of the fog ${when}.`);
    s.out(`You stand in ${this.world.room(p.roomId).title}.`);
    const { coin, bank } = await balances(p.id);
    s.out(`Coin: ${coin} in your purse, ${bank} in the counting house.`);
    const st = await this.combat.load(p);
    const max = maxHealthFor(st.level);
    const next = st.level < MAX_LEVEL ? `, ${xpForLevel(st.level + 1) - st.xp} more to level ${st.level + 1}` : '';
    s.out(`Level ${st.level}. Health ${st.health}/${max}. Experience ${st.xp}${next}.`);
    const chill = st.chillUntil - Date.now();
    if (chill > 0) s.out(c.dim(`A grave chill is on you: weaker aim for ${Math.ceil(chill / 60_000)} more minute(s).`));
    if (this.combat.isNew(st)) s.out(c.dim('You are new to these streets: other players can\'t fight you, and death costs you nothing but a chill.'));
  }

  private quit(s: Session): void {
    s.quitting = true;
    // Quitting signs this character out everywhere: saved reconnect tokens stop working.
    for (const [k, t] of this.tokens) if (t.playerId === s.player!.id) this.tokens.delete(k);
    s.out(c.dim('You pull your collar up and walk back into the fog. Saved.'));
    s.conn.setToken(null);
    s.conn.close();
  }

  /** Admin: times the same short chat with Tilly on several ai& models, to pick one by speed and voice. */
  private async aiBench(s: Session, rest: string): Promise<void> {
    const aiand = this.opts.aiand;
    if (!aiand?.isConfigured()) return s.out('No ai& key is set. Add AIAND_API_KEY to the server .env and restart.');
    if (this.benchRunning) return s.out('A bench is already running.');
    this.benchRunning = true;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 15_000).unref();
      const available = await aiand.models(ctrl.signal).catch((err) => {
        s.out(c.error(`Could not list models: ${err instanceof Error ? err.message : err}`));
        return null;
      });
      if (!available) return;
      if (rest.trim().toLowerCase() === 'models') {
        s.out(c.title(`ai& models on this key (${available.length}):`));
        for (const m of available) s.out(`  ${m}${m === aiand.model ? c.dim('  (in use)') : ''}`);
        return;
      }
      const asked = rest.split(/[\s,]+/).filter(Boolean);
      const models = asked.length ? asked : BENCH_DEFAULTS.filter((m) => available.includes(m));
      if (!models.length) return s.out('None of the usual fast models are on this key. Try: aibench models');
      const tilly = this.world.npcs.get('tilly');
      if (!tilly) return s.out('Tilly is missing, so there is nobody to bench with.');
      const card = tilly.card as any;
      s.out(c.title(`Benching ${models.length} model(s) with Tilly, ${BENCH_LINES.length} lines each. Lines: ${BENCH_LINES.map((l) => `"${l}"`).join(', ')}`));
      const rows = await runBench(
        aiand,
        models,
        { ...card, name: tilly.name, light: true, mute: false },
        (row) => {
          const speed = row.times.length ? `avg ${avg(row.times)} ms, slowest ${Math.max(...row.times)} ms` : 'no replies';
          s.out(`${c.title(row.model)}  ${speed}, ${row.valid}/${BENCH_LINES.length} usable`);
          for (const e of row.errors) s.out(c.error(`  ${e}`));
          for (const line of row.samples) s.out(c.dim(`  ${line}`));
        },
      );
      const ranked = rows.filter((r) => r.valid === BENCH_LINES.length).sort((a, b) => avg(a.times) - avg(b.times));
      if (ranked.length) s.out(c.system(`Fastest with every reply usable: ${ranked[0].model} (${avg(ranked[0].times)} ms). Switch with: aimodel ${ranked[0].model}`));
    } finally {
      this.benchRunning = false;
    }
  }
  private benchRunning = false;

  /** Admin: one tiny request to each AI provider, to see which answer and how fast. */
  private async aiPing(s: Session): Promise<void> {
    if (!this.opts.ai) return s.out('No AI service.');
    s.out('Pinging each AI provider...');
    for (const r of await this.opts.ai.ping()) {
      const state = !r.configured ? c.error('no key set') : r.ok ? `ok, ${r.latencyMs} ms` : c.error(`failed after ${r.latencyMs} ms: ${r.error}`);
      s.out(`  ${r.name.padEnd(7)} ${r.model}  ${state}`);
    }
  }

  /** Admin: shows or switches the ai& model in use, until the next restart (AIAND_MODEL in .env makes it stick). */
  private aiModel(s: Session, rest: string): void {
    const aiand = this.opts.aiand;
    if (!aiand?.isConfigured()) return s.out('No ai& key is set.');
    const want = rest.trim();
    if (!want) return s.out(`ai& model in use: ${aiand.model}`);
    aiand.model = want;
    s.out(`ai& model is now ${want} until the next restart. Set AIAND_MODEL=${want} in .env to keep it.`);
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
    // Which AI providers are set up, in the order they're tried, and how each last went.
    const providers = this.opts.ai?.status() ?? [];
    if (providers.length) {
      s.out(c.title('AI providers, in the order tried'));
      for (const pr of providers) {
        const state = !pr.configured
          ? c.error('no key set')
          : !pr.last
            ? c.dim('not called since the last restart')
            : pr.last.ok
              ? `ok, ${pr.last.latencyMs} ms, ${Math.round((Date.now() - pr.last.at) / 60000)} min ago`
              : c.error(`failed ${Math.round((Date.now() - pr.last.at) / 60000)} min ago: ${pr.last.error}`);
        s.out(`  ${pr.name.padEnd(7)} ${pr.model}  ${state}`);
      }
    }
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
    s.out(c.dim('  ai& and free tiers cost $0; the last column is what it would cost at paid Groq rates, for reference.'));
    const byNpc = await query(
      `SELECT CASE WHEN npc_id ~ '^m[0-9]+$' THEN 'street folk' ELSE npc_id END AS npc_id,
              count(*)::int AS calls, count(*) FILTER (WHERE provider <> 'scripted')::int AS ai_calls
         FROM ai_usage WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY calls DESC`,
    );
    s.out(c.title('By character'));
    for (const r of byNpc.rows) s.out(`  ${String(r.npc_id).padEnd(16)} ${String(r.calls).padStart(5)} lines, ${r.ai_calls} from the AI`);
  }

  // ---------------------------------------------------------------- ambience

  ambientTick(): void {
    // At most one idle line per room each beat, so three rats don't all squabble at once.
    const spoke = new Set<string>();
    for (const npc of this.world.npcs.values()) {
      const lines = npc.card.ambient ?? [];
      if (!lines.length || spoke.has(npc.roomId) || !this.playersIn(npc.roomId).length) continue;
      if (this.rand() < 0.15) {
        spoke.add(npc.roomId);
        this.toRoom(npc.roomId, c.dim(lines[Math.floor(this.rand() * lines.length)]));
      }
    }
  }

  onlineNames(): string[] {
    return [...this.byPlayer.values()].map((s) => s.player!.name);
  }

  listOnline(): string {
    return listJoin(this.onlineNames());
  }
}
