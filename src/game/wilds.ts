// Outside the walls: the shrine and its ritual, fortunes, fishing, crafting, snares, light in dark
// places, the ferry, the brigands' toll at the bend, and a few things that are only sometimes there.
// Every roll, step and reward is decided here; characters only ever add words.

import { query } from '../db/pool.js';
import { claimScavenge, createItem, deleteItem, getFlag, moveCoin, NotEnough, setFlag, tx, type Item } from './economy.js';
import { findItem } from './commerce.js';
import { maxHealthFor, type Mob, type PlayerState } from './combat.js';
import type { Session } from './session.js';
import { c, capitalize } from './text.js';
import { cleanTarget, type Exit, type Room } from './world.js';
import type { Game } from './game.js';

export const SHRINE = 'shrine';
const STEPS = ['offer', 'ring', 'bow', 'bow', 'clap', 'clap', 'pray', 'bow'] as const;
type Step = (typeof STEPS)[number];
const PURIFY_MS = 15 * 60_000;
const FAVOUR_MS = 30 * 60_000;
const CURSE_MS = 30 * 60_000;
const AMBUSH_COOLDOWN_MS = 10 * 60_000;
const GHOST_COOLDOWN_MS = 30 * 60_000;
const GHOST_FAVOUR_MS = 60 * 60_000;
const STICK_COOLDOWN_MS = 2 * 60_000;
const MAX_SNARES = 3;

/** Where you can fish, and what bites: [item, weight]. */
export const FISHING: Record<string, Array<[string, number]>> = {
  river_docks: [['roach', 5], ['eel', 4], ['old_boot', 1]],
  drovers_ford: [['minnow', 5], ['trout', 3]],
  mere_stream: [['perch', 4], ['roach', 3], ['pike', 1]],
  mere_shore: [['perch', 5], ['roach', 2], ['pike', 2]],
  mere_jetty: [['perch', 5], ['roach', 2], ['pike', 2]],
  mere_reeds: [['perch', 4], ['pike', 2], ['eel', 2]],
  mere_boathouse: [['perch', 3], ['eel', 3], ['old_boot', 1]],
  mere_deep: [['perch', 3], ['pike', 4]],
  falls_pool: [['trout', 5], ['minnow', 1]],
  overflow: [['eel', 5]],
};

const BAITS: Array<[string, number]> = [
  ['bait', 0.75],
  ['worm', 0.6],
  ['bread', 0.55],
];

export interface Recipe {
  id: string;
  words: string[];
  needs: Array<{ any: string[]; n: number; label: string }>;
  fire?: boolean;
  makes: string;
}

export const RECIPES: Recipe[] = [
  { id: 'bandage', words: ['bandage', 'bandages'], needs: [{ any: ['rags'], n: 2, label: '2 bundles of rags' }], makes: 'You tear the rags into strips and roll them tight. A bandage, of sorts.' },
  {
    id: 'torch',
    words: ['torch'],
    needs: [
      { any: ['rags'], n: 1, label: 'rags' },
      { any: ['stick'], n: 1, label: 'a stick' },
      { any: ['lamp_oil'], n: 1, label: 'lamp oil' },
    ],
    makes: 'You wind the rags round the end of the stick and soak them in lamp oil. A torch, ready to light.',
  },
  { id: 'bait', words: ['bait'], needs: [{ any: ['bread'], n: 1, label: 'bread' }], makes: 'You knead the bread with a little fat and spit into a sticky ball. Fish will love it. You will not.' },
  {
    id: 'campfire_stew',
    words: ['stew', 'campfire stew', 'campfire'],
    needs: [
      { any: ['minnow', 'roach', 'perch', 'trout', 'eel', 'pike', 'rabbit', 'venison', 'goat_meat', 'boar_meat', 'salt_fish'], n: 1, label: 'fish or meat' },
      { any: ['turnip'], n: 1, label: 'a turnip' },
    ],
    fire: true,
    makes: 'You boil it all up over the fire in a borrowed pot until it smells like dinner. Campfire stew.',
  },
  {
    id: 'snare',
    words: ['snare', 'trap'],
    needs: [
      { any: ['rope'], n: 1, label: 'rope' },
      { any: ['stick'], n: 1, label: 'a stick' },
    ],
    makes: 'You tie a running noose and peg it to the stick. A snare, ready to set on a rabbit run.',
  },
];

const FORTUNES: Array<{ name: string; weight: number; line: string; favour?: boolean; curse?: boolean }> = [
  { name: 'GREAT BLESSING', weight: 1, line: 'All you wish for comes near. Travel is good. The lost thing is found. The fox walks beside you.', favour: true },
  { name: 'BLESSING', weight: 3, line: 'Your road is clear for a while. Trade goes well. Be generous and it returns.' },
  { name: 'MIDDLE BLESSING', weight: 3, line: 'Neither good nor ill. Mend what is torn. The one you wait for comes late.' },
  { name: 'SMALL BLESSING', weight: 3, line: 'A small kindness repays you. Do not lend money. Fish on still days.' },
  { name: 'BLESSING YET TO COME', weight: 2, line: 'Not yet. Patience. What is closed will open when it opens.' },
  { name: 'CURSE', weight: 2, line: 'Your hand will waver and your purse will leak. Do not keep this. Tie it to the tree.', curse: true },
  { name: 'GREAT CURSE', weight: 1, line: 'Beware the road, the water and the dark. Tie this to the tree at once.', curse: true },
];

interface Ambush {
  mobs: string[];
  toll: number;
  at: number;
}

export class Wilds {
  /** Where each player is in the shrine ritual. */
  private ritual = new Map<number, { purifiedAt: number; step: number }>();
  private side = new Map<number, number>();
  private foxLead = new Map<number, number>();
  private ambushes = new Map<number, Ambush>();
  private ambushAt = new Map<number, number>();
  private ghost = new Map<number, number>(); // the old man stands at the toll stump for this player until then
  private ghostAt = new Map<number, number>();
  private sticksAt = new Map<string, number>();
  private wightAt = 0;
  /** Brigands brought out for an ambush, and when: the ones that run off go home after a while. */
  private ambushMobs = new Map<string, number>();
  private lastGrandmother = 0;
  /** Tests can settle the falls and the night; otherwise they follow the clock. */
  quietFalls: boolean | null = null;
  night: boolean | null = null;

  constructor(private game: Game, private opts: { castMs?: number; snareMs?: number; foxChance?: number; ambushChance?: number; ghostChance?: number; ambushCooldownMs?: number } = {}) {}

  private get r(): () => number {
    return () => this.game.random();
  }

  private st(s: Session): PlayerState | undefined {
    return this.game.combat.state(s.player!.id);
  }

  private here(s: Session): Room {
    return this.game.world.room(s.player!.roomId);
  }

  private async mine(s: Session): Promise<Item[]> {
    return this.game.commerce.myItems(s);
  }

  private async load(s: Session): Promise<number> {
    const mine = await this.mine(s);
    return mine.reduce((w, i) => w + i.template.weight, 0) + this.game.combat.extraLoad(s.player!.id);
  }

  /** Gives an item, or leaves it at the player's feet when the pack is full. */
  private async grant(s: Session, templateId: string): Promise<string> {
    const t = this.game.catalog.template(templateId);
    if ((await this.load(s)) + t.weight > 20) {
      await createItem(null, templateId, { type: 'room', id: s.player!.roomId });
      return `${t.name}, but your pack is full, so it goes at your feet`;
    }
    await createItem(null, templateId, { type: 'player', id: s.player!.id });
    return t.name;
  }

  private isNight(): boolean {
    if (this.night !== null) return this.night;
    const hour = Number(new Intl.DateTimeFormat('en-CA', { hour: 'numeric', hour12: false, timeZone: 'America/Toronto' }).format(new Date()));
    return hour >= 20 || hour < 6;
  }

  private fallsAreQuiet(): boolean {
    if (this.quietFalls !== null) return this.quietFalls;
    return Math.floor(Date.now() / 3_600_000) % 2 === 0;
  }

  // ---------------------------------------------------------------- moving about

  /**
   * Doors that only open sometimes or for some people. Returns a line to show instead of moving,
   * 'handled' when the move was dealt with here, or null to let the move go ahead.
   */
  async canEnter(s: Session, room: Room, exit: Exit): Promise<string | 'handled' | null> {
    const p = s.player!;
    const amb = this.ambushes.get(p.id);
    if (amb && room.id === 'brigands_bend' && this.ambushersHere(amb).length) {
      this.springAmbush(s, amb);
      return 'handled';
    }
    if (exit.to === 'mere_island' && room.id === 'mere_jetty') return 'The island is a long, cold swim through black water. The ferryman rows people over for a coin: ferry.';
    if (exit.to === 'mere_jetty' && room.id === 'mere_island') return 'It is a long swim back. Wait for the ferryman: ferry.';
    if (exit.to === 'fox_grove') {
      if ((this.foxLead.get(p.id) ?? 0) > Date.now()) return null;
      return 'The cedars stand shoulder to shoulder there. There is no way through that you can see.';
    }
    if (exit.to === 'behind_falls' && !this.fallsAreQuiet()) {
      const st = this.st(s);
      s.out(c.error('You edge west along the ledge toward the dark behind the water. The falls are running hard today; your foot goes on the slime and you are in the pool before you can shout.'));
      this.game.toRoom(room.id, `${c.player(p.name)} slips off the ledge and drops into the pool with a tremendous splash.`, s);
      if (st) {
        st.health = Math.max(1, st.health - 2);
        st.dirty = true;
      }
      await this.game.placePlayer(s, 'falls_pool', `${c.player(p.name)} comes up spluttering in the pool.`);
      s.out(c.dim('The ledge might be safer on a day when the falls run quieter.'));
      return 'handled';
    }
    const priv = await this.game.town.canEnterPrivate(s, exit.to);
    if (priv) return priv;
    if (room.id === 'toll_stump' && (this.ghost.get(p.id) ?? 0) > Date.now()) this.leftGhost(s);
    return null;
  }

  /** The edge of the world: walk into the fog and you come out where you went in. */
  fogEdge(room: Room): string | null {
    if (!room.flags.includes('outside') || room.district === 'gate') return null;
    return 'You walk into the fog. It closes round you, cold and blind, and for a long time there is nothing but grey. Then the trees come back, and you are exactly where you started, colder than before.';
  }

  async onArrive(s: Session, from: string | null): Promise<void> {
    const p = s.player!;
    const now = Date.now();
    if (p.roomId === 'shrine_basin' && from === 'shrine_gates') {
      if ((this.side.get(p.id) ?? 0) < now) {
        s.out(c.npc('Ahead at the shrine, the old keeper looks up from her sweeping and catches your eye. Smiling, she draws a line in the air along the edge of the path. The middle is the god\'s; walkers keep to the side.'));
      }
      this.side.delete(p.id);
    }
    if (p.roomId === 'brigands_bend') await this.maybeAmbush(s, now);
    if (p.roomId === 'toll_stump') this.maybeGhost(s, now);
    if (p.roomId === 'fox_grove') this.foxLead.delete(p.id);
  }

  /** keep to the side, in the red gates. */
  keepSide(s: Session): void {
    if (s.player!.roomId !== 'shrine_gates') return s.out('You keep to the side of the road. Nobody notices.');
    this.side.set(s.player!.id, Date.now() + 5 * 60_000);
    s.out('You step to the edge of the path and walk on under the gates that way, leaving the middle clear.');
  }

  // ---------------------------------------------------------------- the shrine

  purify(s: Session): void {
    const p = s.player!;
    if (p.roomId !== 'shrine_basin') return s.out('You purify at the water basin, just inside the red gates of the shrine.');
    this.ritual.set(p.id, { purifiedAt: Date.now(), step: 0 });
    s.out('You take up a ladle in your right hand and pour water over your left, then change hands. You pour a little into your cupped palm, rinse your mouth and spit beside the basin, then tip the ladle upright so the last of the water runs down the handle, and lay it back.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} rinses their hands and mouth at the basin.`, s);
  }

  /** One step of the ritual at the shrine: offer, ring, bow, clap, pray. Wrong order and nothing happens. */
  async step(s: Session, act: Step, amount?: number): Promise<void> {
    const p = s.player!;
    if (p.roomId !== SHRINE) {
      const lines: Record<string, [string, string]> = {
        bow: ['You bow.', 'bows.'],
        clap: ['You clap your hands twice.', 'claps twice.'],
        pray: ['You close your eyes and pray, briefly, for whatever you need most.', 'closes their eyes in prayer.'],
        ring: ['There is no bell here to ring.', ''],
        offer: ['There is no offering box here.', ''],
      };
      const [mine, theirs] = lines[act];
      s.out(mine);
      if (theirs) this.game.toRoom(p.roomId, `${c.player(p.name)} ${theirs}`, s);
      return;
    }
    const r = this.ritual.get(p.id);
    if (!r || Date.now() - r.purifiedAt > PURIFY_MS) {
      s.out(c.npc('The keeper sets down her broom, catches your sleeve gently and points back to the water basin: hands and mouth first. Purify.'));
      return;
    }
    const expected = STEPS[r.step];
    if (act !== expected) {
      r.step = 0;
      s.out(c.npc(`The keeper comes to stand beside you and, without a word, shows you: a coin into the box, the rope shaken so the bell sounds, two deep bows, two claps, hands together in prayer, and one last bow. Then she steps back and lets you begin again.`));
      s.out(c.dim('Start again from the offering: offer 1, ring bell, bow, bow, clap, clap, pray, bow.'));
      return;
    }
    if (act === 'offer') {
      const n = Math.max(1, amount ?? 1);
      try {
        await tx((cl) => moveCoin(cl, p.id, -n, 0, 'shrine offering'));
      } catch (err) {
        if (err instanceof NotEnough) return s.out("You haven't that much. One coin is enough.");
        throw err;
      }
      this.game.updateStatus(s);
    }
    r.step++;
    const said: Record<Step, [string, string]> = {
      offer: [`You drop ${amount && amount > 1 ? `${amount} coins` : 'a coin'} into the offering box. It clinks down through the slats.`, 'drops a coin in the offering box.'],
      ring: ['You shake the thick rope. The bronze bell above clanks, deep and dull, and the sound goes off into the trees.', 'rings the shrine bell.'],
      bow: [r.step === STEPS.length ? 'You bow once more, deeply.' : 'You bow, deeply, from the waist.', 'bows deeply.'],
      clap: ['You clap your hands, sharp in the quiet.', 'claps.'],
      pray: ['You press your palms together and pray, in silence, for what you came for.', 'prays in silence.'],
    };
    s.out(said[act][0]);
    this.game.toRoom(p.roomId, `${c.player(p.name)} ${said[act][1]}`, s);
    if (r.step === STEPS.length) await this.blessed(s);
  }

  private async blessed(s: Session): Promise<void> {
    const p = s.player!;
    this.ritual.delete(p.id);
    const today = new Date().toISOString().slice(0, 10);
    const done = await getFlag(p.id, 'shrine:day');
    if (done?.value === today) {
      s.out(c.dim('A deep quiet settles on you. You have had your blessing today; this one is just for the asking.'));
      return;
    }
    await setFlag(p.id, 'shrine:day', today);
    const st = await this.game.combat.load(p);
    st.health = maxHealthFor(st.level);
    st.favourUntil = Date.now() + FAVOUR_MS;
    st.dirty = true;
    s.out(c.system('The bell\'s note goes on longer than it should. Warmth runs through you from the crown of your head down, and every wound you carry closes. The fox\'s favour is on you: your hand is steadier, for a while.'));
    this.game.updateStatus(s);
    if (!(await getFlag(p.id, 'shrine:first'))) {
      await setFlag(p.id, 'shrine:first', '1');
      await this.game.town.rumour(p.id, `${p.name} made the pilgrimage to the forest shrine past Mile Oak`);
    }
    if (this.r() < (this.opts.foxChance ?? 0.2)) {
      this.foxLead.set(p.id, Date.now() + 3 * 60_000);
      s.out(c.npc('As you straighten from the last bow, you see it: a white fox, sitting at the edge of the trees by the path north, watching you. It turns, trots a few steps, and looks back over its shoulder. Follow it: follow fox.'));
    }
  }

  async followFox(s: Session): Promise<void> {
    const p = s.player!;
    if ((this.foxLead.get(p.id) ?? 0) < Date.now() || (p.roomId !== SHRINE && p.roomId !== 'fortune_tree')) {
      return s.out('There is no fox here to follow.');
    }
    s.out(c.system('You follow the white fox north past the fortune tree. Where the cedars stand like a wall it slips between two trunks you would have sworn were touching, and so, somehow, do you.'));
    this.game.toRoom(p.roomId, `${c.player(p.name)} follows something white into the trees and is gone.`, s);
    this.foxLead.set(p.id, Date.now() + 60_000);
    await this.game.placePlayer(s, 'fox_grove', `${c.player(p.name)} steps out from between the cedars.`);
    s.out(c.dim('The white fox sits beside the stone bowl, looks at you once, and is not there any more.'));
  }

  async takeFoxFire(s: Session): Promise<void> {
    const p = s.player!;
    const mine = await this.mine(s);
    if (mine.some((i) => i.template.id === 'fox_fire') || (await getFlag(p.id, 'found:fox_fire'))) {
      return s.out('The bowl is empty for you. The light it held is already yours, wherever you left it.');
    }
    await setFlag(p.id, 'found:fox_fire', '1');
    const got = await this.grant(s, 'fox_fire');
    s.out(c.system(`You cup the pale light in both hands. It is cool, like stream water, and it does not go out. You have ${got}.`));
    s.out(c.dim('It will light any dark place for you, for as long as you carry it.'));
  }

  async drawFortune(s: Session): Promise<void> {
    const p = s.player!;
    if (p.roomId !== 'fortune_tree' && p.roomId !== SHRINE) return s.out('Fortunes are drawn at the fortune tree behind the forest shrine.');
    try {
      await tx((cl) => moveCoin(cl, p.id, -1, 0, 'shrine fortune'));
    } catch (err) {
      if (err instanceof NotEnough) return s.out('A fortune costs one coin, and you have none.');
      throw err;
    }
    const total = FORTUNES.reduce((n, f) => n + f.weight, 0);
    let roll = this.r() * total;
    let f = FORTUNES[0];
    for (const x of FORTUNES) {
      if ((roll -= x.weight) < 0) {
        f = x;
        break;
      }
    }
    const num = 1 + Math.floor(this.r() * 100);
    s.out(`You drop a coin in the box and shake the six sided case until a stick slides out of the hole. Number ${num}. You take slip ${num} from its little drawer and unfold it.`);
    s.out(c.title(f.name));
    s.out(f.line);
    this.game.toRoom(p.roomId, `${c.player(p.name)} draws a fortune.`, s);
    const st = await this.game.combat.load(p);
    if (f.favour) {
      st.favourUntil = Math.max(st.favourUntil, Date.now() + 15 * 60_000);
      s.out(c.dim('You feel lucky. Your hand is steadier, for a while.'));
    }
    if (f.curse) {
      st.curseUntil = Date.now() + CURSE_MS;
      await createItem(null, 'curse_slip', { type: 'player', id: p.id });
      s.out(c.dim('Keep this and it will hang on you for half an hour. Tie it to the fortune tree to leave it behind: tie fortune.'));
    }
    this.game.updateStatus(s);
  }

  async tieFortune(s: Session): Promise<void> {
    const p = s.player!;
    const slips = (await this.mine(s)).filter((i) => i.template.id === 'curse_slip');
    if (!slips.length) return s.out("You have no bad fortune to leave behind. Lucky you.");
    if (p.roomId !== 'fortune_tree') return s.out('Bad fortunes are tied to the fortune tree behind the forest shrine.');
    await tx(async (cl) => {
      for (const i of slips) await deleteItem(cl, i.id, { type: 'player', id: p.id });
    });
    const st = await this.game.combat.load(p);
    st.curseUntil = 0;
    s.out('You fold the slip into a strip and knot it to a twig among the hundreds of others. The bad luck stays with the tree. You feel lighter.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} ties a fortune to the tree.`, s);
  }

  // ---------------------------------------------------------------- light and dark

  isDark(roomId: string): boolean {
    return this.game.world.room(roomId).flags.includes('dark');
  }

  /** A lit light, or the fox fire that never goes out. */
  async hasLight(s: Session): Promise<boolean> {
    const st = this.st(s);
    if (st && st.lightUntil > Date.now()) return true;
    return (await this.mine(s)).some((i) => i.template.id === 'fox_fire');
  }

  /** In the dark without a light, there's nothing to see. */
  async blind(s: Session): Promise<boolean> {
    return this.isDark(s.player!.roomId) && !(await this.hasLight(s));
  }

  /** light torch, candle, lamp or incense. False when it's nothing this knows about. */
  async light(s: Session, rest: string): Promise<boolean> {
    const mine = await this.mine(s);
    const item = findItem(mine, rest);
    if (!item) return false;
    const p = s.player!;
    const st = await this.game.combat.load(p);
    const now = Date.now();
    const burn = (ms: number) => {
      st.lightUntil = Math.max(st.lightUntil, now) + ms;
    };
    switch (item.template.id) {
      case 'fox_fire':
        s.out('The fox fire glows already, cool and steady. It never goes out.');
        return true;
      case 'torch':
        await tx((cl) => deleteItem(cl, item.id, { type: 'player', id: p.id }));
        burn(30 * 60_000);
        s.out('You light the torch. It roars up yellow and smoky and pushes the dark right back. It will burn for half an hour.');
        break;
      case 'candle':
      case 'tallow_stub':
        await tx((cl) => deleteItem(cl, item.id, { type: 'player', id: p.id }));
        burn(item.template.id === 'candle' ? 10 * 60_000 : 5 * 60_000);
        s.out(`You light ${item.template.name}. A small, shaking light. It won't last long.`);
        break;
      case 'lamp': {
        const oil = mine.find((i) => i.template.id === 'lamp_oil');
        if (!oil) {
          s.out('The lamp is dry. You need lamp oil to fill it. Maud sells it.');
          return true;
        }
        await tx((cl) => deleteItem(cl, oil.id, { type: 'player', id: p.id }));
        burn(60 * 60_000);
        s.out('You fill the lamp from the flask and light it. A steady yellow circle pushes back the dark. The oil will last an hour.');
        break;
      }
      case 'incense': {
        await tx((cl) => deleteItem(cl, item.id, { type: 'player', id: p.id }));
        if (this.here(s).district === 'shrine') {
          const max = maxHealthFor(st.level);
          st.health = Math.min(max, st.health + 5);
          st.dirty = true;
          s.out('You light the incense and set it in the burner. The smoke rises straight up in the still air, and something in you heals a little. ' + c.dim(`(${st.health}/${max})`));
          this.game.updateStatus(s);
        } else {
          s.out('You light the incense. Fragrant smoke curls up and is gone. It would mean more at the shrine.');
        }
        this.game.toRoom(p.roomId, `${c.player(p.name)} lights a stick of incense.`, s);
        return true;
      }
      default:
        return false;
    }
    this.game.toRoom(p.roomId, `${c.player(p.name)} lights ${item.template.name}.`, s);
    if (this.isDark(p.roomId)) await this.game.look(s, '');
    return true;
  }

  // ---------------------------------------------------------------- sticks, worms and snares

  /** take stick: the forest floor has plenty. */
  async takeStick(s: Session): Promise<boolean> {
    const p = s.player!;
    if (!this.here(s).flags.includes('sticks')) return false;
    const key = `${p.id}:${p.roomId}`;
    if ((this.sticksAt.get(key) ?? 0) > Date.now()) {
      s.out("You've picked the good sticks from here. Try further on, or wait a little.");
      return true;
    }
    if ((await this.load(s)) + 1 > 20) {
      s.out('Your pack is too full for even a stick.');
      return true;
    }
    this.sticksAt.set(key, Date.now() + STICK_COOLDOWN_MS);
    await createItem(null, 'stick', { type: 'player', id: p.id });
    s.out('You pick out a good dry stick from the deadwood.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} gathers a stick.`, s);
    return true;
  }

  async dig(s: Session): Promise<void> {
    const p = s.player!;
    const room = this.here(s);
    if (room.id === 'mere_island') return this.digIsland(s);
    if (!room.flags.includes('worms')) return s.out(room.flags.includes('outside') ? 'The ground here is all stones and roots. Try somewhere softer and wetter for worms.' : 'Dig here? Not with your hands.');
    if (!(await claimScavenge(p.id, `dig:${room.id}`))) return s.out("You've turned this ground over already. Give the worms an hour to come back.");
    await createItem(null, 'worm', { type: 'player', id: p.id });
    await createItem(null, 'worm', { type: 'player', id: p.id });
    s.out('You dig your fingers into the soft black earth and come up with two fat worms. Good bait.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} digs in the dirt for worms.`, s);
  }

  private async digIsland(s: Session): Promise<void> {
    const p = s.player!;
    if (await getFlag(p.id, 'found:hermit_bell')) return s.out('You dig under the yew again. Only roots now, and the hollow where the bell lay.');
    await setFlag(p.id, 'found:hermit_bell', '1');
    const got = await this.grant(s, 'hermit_bell');
    s.out(c.system(`You dig between the roots of the old yew where the earth is soft. A hand's depth down your fingers find cloth, rotten to nothing, and inside it something hard and cold: ${got}.`));
    s.out(c.dim('The yew creaks once above you, as if settling back to sleep.'));
    this.game.toRoom(p.roomId, `${c.player(p.name)} digs something out from under the yew.`, s);
  }

  async setSnare(s: Session): Promise<void> {
    const p = s.player!;
    if (!this.here(s).flags.includes('snare')) return s.out('Snares go on rabbit runs in the Edgewood: the Rabbit Runs, Bramble Hollow, the Bracken Slope.');
    const snare = (await this.mine(s)).find((i) => i.template.id === 'snare');
    if (!snare) return s.out('You have no snare. Make one from rope and a stick: make snare.');
    const { rows } = await query('SELECT count(*)::int AS n FROM snares WHERE player_id=$1', [p.id]);
    if (rows[0].n >= MAX_SNARES) return s.out(`You have ${MAX_SNARES} snares set already. Check them first.`);
    await tx(async (cl) => {
      if (!(await deleteItem(cl, snare.id, { type: 'player', id: p.id }))) throw new Error('gone');
      await cl.query('INSERT INTO snares (player_id, room_id) VALUES ($1,$2)', [p.id, p.roomId]);
    });
    s.out('You find a well worn run between two burrows and set the noose across it, pegged down tight. Come back in a while: check snare.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} crouches and sets a snare on a rabbit run.`, s);
  }

  async checkSnare(s: Session): Promise<void> {
    const p = s.player!;
    const { rows } = await query('SELECT id, set_at FROM snares WHERE player_id=$1 AND room_id=$2 ORDER BY id', [p.id, p.roomId]);
    if (!rows.length) {
      const { rows: all } = await query('SELECT room_id FROM snares WHERE player_id=$1', [p.id]);
      if (!all.length) return s.out('You have no snares set.');
      return s.out(`Your snares are set elsewhere: ${[...new Set(all.map((r) => this.game.world.room(r.room_id).title))].join(', ')}.`);
    }
    const ready = rows.filter((r) => Date.now() - new Date(r.set_at).getTime() >= (this.opts.snareMs ?? 10 * 60_000));
    if (!ready.length) return s.out('Nothing yet. The noose lies empty across the run. Rabbits take their time.');
    for (const r of ready) {
      const caught = this.r() < 0.7;
      const kept = this.r() < 2 / 3;
      const { rowCount } = await query('DELETE FROM snares WHERE id=$1', [r.id]);
      if (rowCount !== 1) continue;
      if (caught) s.out(`A rabbit, caught clean. You take ${await this.grant(s, 'rabbit')}.`);
      else s.out('The snare has been sprung, and whatever it caught got away.');
      if (kept) s.out(`The snare is still good. You take ${await this.grant(s, 'snare')}.`);
      else s.out('The snare is broken past mending.');
    }
    this.game.toRoom(p.roomId, `${c.player(p.name)} checks a snare.`, s);
  }

  // ---------------------------------------------------------------- crafting

  recipes(s: Session): void {
    s.out(c.title('Things you know how to make'));
    for (const r of RECIPES) {
      const name = this.game.catalog.template(r.id).name;
      s.out(`  ${c.thing(name)}: ${r.needs.map((n) => n.label).join(', ')}${r.fire ? ', at a fire' : ''}.  ${c.dim(`make ${r.words[0]}`)}`);
    }
    s.out(c.dim('Sticks lie about the forest for the taking. Fires burn at the Burnt Waystation, the charcoal burner\'s clearing and the Drowned Rat.'));
  }

  async make(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const t = cleanTarget(rest);
    if (!t) return this.recipes(s);
    const recipe = RECIPES.find((r) => r.words.some((w) => w === t || t.endsWith(w))) ?? RECIPES.find((r) => r.words.some((w) => w.startsWith(t)));
    if (!recipe) return s.out(`You don't know how to make that. Type recipes.`);
    if (recipe.fire && !this.here(s).flags.includes('fire')) return s.out('You need a fire for that: the Burnt Waystation, the charcoal burner\'s clearing, or the Drowned Rat.');
    const mine = await this.mine(s);
    const used: Item[] = [];
    const missing: string[] = [];
    for (const need of recipe.needs) {
      const have = mine.filter((i) => need.any.includes(i.template.id) && !used.includes(i)).slice(0, need.n);
      if (have.length < need.n) missing.push(need.label);
      else used.push(...have);
    }
    if (missing.length) return s.out(`To make that you need ${recipe.needs.map((n) => n.label).join(', ')}. You're missing ${missing.join(', ')}.`);
    // All or nothing: every input is used once, or none are.
    try {
      await tx(async (cl) => {
        for (const i of used) if (!(await deleteItem(cl, i.id, { type: 'player', id: p.id }))) throw new Error('gone');
        await createItem(cl, recipe.id, { type: 'player', id: p.id });
      });
    } catch {
      return s.out('Something you needed is gone from your pack.');
    }
    s.out(recipe.makes);
    this.game.toRoom(p.roomId, `${c.player(p.name)} makes ${this.game.catalog.template(recipe.id).name}.`, s);
  }

  // ---------------------------------------------------------------- fishing

  async fish(s: Session): Promise<void> {
    const p = s.player!;
    const table = FISHING[p.roomId];
    if (!table) return s.out(this.here(s).flags.includes('water') ? 'The water here is too fast to fish. Try a pool, the ford, the lake or the docks.' : 'There is no water here worth fishing.');
    if (this.game.combat.inCombat(p.id)) return s.out("You can't fish in the middle of a fight.");
    const mine = await this.mine(s);
    if (!mine.some((i) => i.template.id === 'fishing_rod')) return s.out('You need a fishing rod. Maud sells them at Market East.');
    const bait = BAITS.map(([id, chance]) => ({ item: mine.find((i) => i.template.id === id), chance, id })).find((b) => b.item);
    if (!bait?.item) return s.out('You need bait: dig for worms, use bread, or make bait.');
    const ok = await tx((cl) => deleteItem(cl, bait.item!.id, { type: 'player', id: p.id }));
    if (!ok) return;
    s.out(`You bait the hook with ${bait.item.template.name} and cast. The float settles on the water. ${c.dim('(type anything to reel in)')}`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} casts a line.`, s);
    this.game.busy(s, this.opts.castMs ?? 4000, 'You reel in.', () => this.landCast(s, bait.id, bait.chance, table));
  }

  private async landCast(s: Session, bait: string, chance: number, table: Array<[string, number]>): Promise<void> {
    const p = s.player!;
    const roomId = p.roomId;
    if (roomId === 'mere_deep' && this.r() < 1 / 40) return this.grandmother(s, bait);
    if (roomId === 'overflow' && this.r() < 0.1) {
      const st = this.st(s);
      if (st) {
        st.health = Math.max(1, st.health - 2);
        st.dirty = true;
        this.game.updateStatus(s);
      }
      return s.out(c.error('The float goes under. You pull, and something pulls back, and then it lets go of the line and bites your hand instead, and is gone. Some things are better left in the water.'));
    }
    if (this.r() >= chance) return s.out('Nothing. The float bobs, and bobs, and nothing takes it. The bait is gone.');
    const total = table.reduce((n, [, w]) => n + w, 0);
    let roll = this.r() * total;
    let pick = table[0][0];
    for (const [id, w] of table) {
      if ((roll -= w) < 0) {
        pick = id;
        break;
      }
    }
    const got = await this.grant(s, pick);
    s.out(pick === 'old_boot' ? `The float goes under, you strike, and haul in ${got}. Well.` : `The float dips and dives. You strike and land ${got}.`);
    this.game.toRoom(roomId, `${c.player(p.name)} lands ${this.game.catalog.template(pick).name}.`, s);
  }

  private async grandmother(s: Session, bait: string): Promise<void> {
    const p = s.player!;
    const landed = bait === 'bait' && this.r() < 0.5 && Date.now() - this.lastGrandmother > 24 * 60 * 60_000;
    if (!landed) {
      s.out(c.error('The float does not dip. It vanishes. The rod bends double, the line sings, something vast turns far down in the black water, and the line parts like cotton. Out on the mere, a great back rolls once, and is gone.'));
      this.game.toRoom(p.roomId, `${c.player(p.name)}'s rod bends double, and the line snaps.`, s);
      return;
    }
    if ((await this.load(s)) + 8 > 20) {
      s.out(c.error('You fight her for an age and bring her to the bank: a pike as long as you are. But you could never carry her with your pack this full, and while you stare she rolls once and slides back into the deep. Nobody will believe you.'));
      return;
    }
    this.lastGrandmother = Date.now();
    await createItem(null, 'grandmother_pike', { type: 'player', id: p.id });
    s.out(c.system('The float vanishes and the rod nearly goes with it. You fight for what feels like an hour, give line, take it back, give it again, until at last you drag her up onto the stones: the Grandmother, a pike as long as you are, old as the ferryman, her jaw hung with fifty years of other people\'s hooks. Nobody is going to believe this.'));
    this.game.toRoom(p.roomId, `${c.player(p.name)} hauls an enormous pike out of the deep water.`, s);
    await this.game.town.rumour(p.id, `${p.name} landed the Grandmother pike from the deep water of the mere`);
  }

  // ---------------------------------------------------------------- the ferry and the falls

  async ferry(s: Session): Promise<void> {
    const p = s.player!;
    if (p.roomId === 'mere_island') {
      s.out(c.npc('You wave. After a while the ferryman comes out to you, says nothing, and rows you back to the jetty.'));
      this.game.toRoom(p.roomId, `${c.player(p.name)} is rowed back across the mere.`, s);
      return this.game.placePlayer(s, 'mere_jetty', `The ferryman's boat bumps the jetty and ${c.player(p.name)} climbs out.`);
    }
    if (!this.game.world.npcsIn(p.roomId).some((n) => n.id === 'ferryman')) return s.out('The ferryman keeps his boat at the jetty on the mere.');
    try {
      await tx((cl) => moveCoin(cl, p.id, -1, 0, 'ferry to the island'));
    } catch (err) {
      if (err instanceof NotEnough) return s.out(c.npc('The ferryman holds out a hand. "Coin." He waits. You have none.'));
      throw err;
    }
    this.game.updateStatus(s);
    s.out(c.npc('You hand the ferryman a coin. He folds his net, steps down into the boat, and rows you out across the black water without a word. Halfway, he stops rowing for a long moment and stares down into the deep. Then he rows on.'));
    this.game.toRoom(p.roomId, `The ferryman rows ${p.name} out toward the island.`, s);
    await this.game.placePlayer(s, 'mere_island', `The ferryman's boat grates on the shingle and ${c.player(p.name)} steps ashore.`);
    s.out(c.dim('When you want to go back, type ferry and he will come for you.'));
  }

  async searchFalls(s: Session): Promise<void> {
    const p = s.player!;
    if (await getFlag(p.id, 'found:pilgrim')) return s.out('The pilgrim lies as before. You have already taken what they had to give.');
    await setFlag(p.id, 'found:pilgrim', '1');
    const a = await this.grant(s, 'pilgrim_journal');
    const b = await this.grant(s, 'pilgrim_token');
    s.out(c.system(`In the pilgrim's cloak pocket you find ${a}, and ${b}. You say a word for them, which is more than anyone has in a long time.`));
  }

  // ---------------------------------------------------------------- the barrow

  async takeTorc(s: Session): Promise<void> {
    const p = s.player!;
    const wight = [...this.game.combat.mobs.values()].find((m) => m.kind === 'wight');
    if (wight) return s.out('The shelf is bare, and something tall stands between you and it.');
    if (await getFlag(p.id, 'found:torc')) return s.out('You have taken from the barrow once. The shelf is bare to you now.');
    await setFlag(p.id, 'found:torc', '1');
    const got = await this.grant(s, 'barrow_torc');
    s.out(`You lift the torc from the shelf. It is very heavy and very cold. You have ${got}.`);
    s.out(c.error('Behind you, in the dark of the passage, bones shift in their chamber. Something stands up that has been lying down for three thousand years.'));
    this.game.toRoom(p.roomId, `${c.player(p.name)} takes the torc from the shelf, and the barrow wakes.`, s);
    const m = this.game.combat.spawn('wight', 'barrow', null);
    this.wightAt = Date.now();
    const st = this.st(s);
    if (st && !this.game.combat.isNew(st)) m.target = `p:${p.id}`;
    else s.out(c.dim('The wight turns its cold eyes on you, and seems to decide you are too new to this world to be worth the trouble. It waits.'));
  }

  /** Leave something in the barrow instead: the stones hum, once a day. */
  async leaveInBarrow(s: Session, item: Item): Promise<void> {
    const p = s.player!;
    const ok = await tx((cl) => deleteItem(cl, item.id, { type: 'player', id: p.id }));
    if (!ok) return s.out("You aren't carrying that anymore.");
    s.out(`You lay ${item.template.name} on the stone shelf, beside the skull, and step back.`);
    const today = new Date().toISOString().slice(0, 10);
    if ((await getFlag(p.id, 'barrow:day'))?.value === today) return s.out(c.dim('The dark is quiet. It has had a gift from you today.'));
    await setFlag(p.id, 'barrow:day', today);
    const st = await this.game.combat.load(p);
    st.favourUntil = Math.max(st.favourUntil, Date.now() + FAVOUR_MS);
    s.out(c.system('Above you, out on the hill, the standing stones hum, all nine together, a note you feel in your back teeth. Something in the dark is pleased. Your hand feels steadier.'));
  }

  // ---------------------------------------------------------------- the road: the old man and the brigands

  private maybeGhost(s: Session, now: number): void {
    const p = s.player!;
    if ((this.ghostAt.get(p.id) ?? 0) > now) return;
    if (!this.isNight() && this.r() >= (this.opts.ghostChance ?? 0.15)) return;
    this.ghostAt.set(p.id, now + GHOST_COOLDOWN_MS);
    this.ghost.set(p.id, now + 5 * 60_000);
    s.out(c.npc('The air goes still and cold. Beside the burnt toll stump stands an old man in a tollman\'s coat, grey all through, as if made of ash. You can see the road through him. He holds out one hand, palm up, and waits. One coin, his eyes say. Pay, or walk on.'));
  }

  private leftGhost(s: Session): void {
    const p = s.player!;
    this.ghost.delete(p.id);
    const st = this.st(s);
    if (st) st.curseUntil = Math.max(st.curseUntil, Date.now() + 10 * 60_000);
    s.out(c.error('As you pass the old man, a hand like cold water touches the back of your neck. A chill settles in your fingers. Your hand will shake a while.'));
  }

  private async maybeAmbush(s: Session, now: number): Promise<void> {
    const p = s.player!;
    const st = await this.game.combat.load(p);
    if (this.game.combat.isNew(st) || st.ghostUntil > now) return;
    if (this.ambushes.has(p.id) || (this.ambushAt.get(p.id) ?? 0) > now) return;
    if (this.r() >= (this.opts.ambushChance ?? 0.4)) return;
    this.ambushAt.set(p.id, now + (this.opts.ambushCooldownMs ?? AMBUSH_COOLDOWN_MS));
    const n = 2 + (this.r() < 0.5 ? 1 : 0);
    const mobs: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = this.game.combat.spawn('brigand', 'brigands_bend', null).id;
      mobs.push(id);
      this.ambushMobs.set(id, now);
    }
    const { rows } = await query('SELECT coin FROM players WHERE id=$1', [p.id]);
    const toll = Math.max(2, Math.ceil((rows[0]?.coin ?? 0) / 3));
    this.ambushes.set(p.id, { mobs, toll, at: now });
    const lead = this.game.combat.mobs.get(mobs[0])!;
    s.out(c.error(`${n === 3 ? 'Three' : 'Two'} figures step out of the holly on both sides of the road, red bands on their arms and blades out. ${capitalize(this.game.combat.mobName(lead))} grins. "Toll, pigeon. ${toll} coin, and you walk on. Don't pay, and you don't walk."`));
    s.out(c.dim(`pay, to pay the toll. attack, to fight. Walking on without paying is fighting.`));
    this.game.toRoom(p.roomId, c.error(`Brigands step out of the holly round ${p.name}.`), s);
  }

  /** The brigands of an ambush still standing in the bend. */
  private ambushersHere(amb: Ambush): Mob[] {
    return amb.mobs.map((id) => this.game.combat.mobs.get(id)).filter((m): m is Mob => !!m && m.npc.roomId === 'brigands_bend');
  }

  private springAmbush(s: Session, amb: Ambush): void {
    const p = s.player!;
    const st = this.st(s);
    s.out(c.error('The brigands step into your way, blades up. "Wrong answer, pigeon."'));
    this.game.toRoom(p.roomId, c.error(`The brigands close on ${p.name}.`), s);
    const here = this.ambushersHere(amb);
    for (const m of here) if (!m.target) m.target = `p:${p.id}`;
    if (st && !st.target && here[0]) st.target = `m:${here[0].id}`;
  }

  /** pay: the brigands' toll at the bend, or the old man's coin at the toll stump. */
  async pay(s: Session): Promise<void> {
    const p = s.player!;
    if (p.roomId === 'toll_stump' && (this.ghost.get(p.id) ?? 0) > Date.now()) return this.payGhost(s);
    const amb = this.ambushes.get(p.id);
    if (!amb || p.roomId !== 'brigands_bend') return s.out('Nobody here is asking for anything. Yet.');
    if (this.game.combat.state(p.id)?.target) return s.out("It's a bit late to pay now.");
    const { rows } = await query('SELECT coin FROM players WHERE id=$1', [p.id]);
    const coin = rows[0]?.coin ?? 0;
    const take = Math.min(coin, amb.toll);
    if (take > 0) {
      await tx((cl) => moveCoin(cl, p.id, -take, 0, 'brigand toll at the bend'));
      s.out(`You count ${take} coin into a dirty palm. It closes. "Pleasure doing business, pigeon."`);
    } else {
      const mine = (await this.mine(s)).filter((i) => i.template.kind !== 'job').sort((a, b) => b.template.price - a.template.price);
      if (mine[0]) {
        await tx((cl) => deleteItem(cl, mine[0].id, { type: 'player', id: p.id }));
        s.out(`You have no coin. A brigand takes ${mine[0].template.name} instead, and weighs it in their hand. "This'll do."`);
      } else {
        s.out('You turn out empty pockets. The brigands look at each other and laugh. One of them shoves you on up the road.');
      }
    }
    this.clearAmbush(p.id, 'The brigands melt back into the holly as if they had never been there.');
    this.game.updateStatus(s);
  }

  private async payGhost(s: Session): Promise<void> {
    const p = s.player!;
    try {
      await tx((cl) => moveCoin(cl, p.id, -1, 0, 'the old tollman'));
    } catch (err) {
      if (err instanceof NotEnough) return s.out('You have no coin to give him. He waits, and waits.');
      throw err;
    }
    this.ghost.delete(p.id);
    const st = await this.game.combat.load(p);
    st.ghostUntil = Date.now() + GHOST_FAVOUR_MS;
    s.out(c.system('You lay a coin in the grey palm. It goes straight through and rings on the iron of the toll box. The old man nods, slowly, raises his hat, and is wind and ash and gone. The road ahead feels kinder. For a while, nobody on it will trouble you.'));
    this.game.updateStatus(s);
  }

  private clearAmbush(playerId: number, line?: string): void {
    const amb = this.ambushes.get(playerId);
    if (!amb) return;
    this.ambushes.delete(playerId);
    let shown = false;
    for (const id of amb.mobs) {
      const m = this.game.combat.mobs.get(id);
      if (!m) continue;
      this.game.combat.endFightsWith(`m:${id}`);
      if (line && !shown) {
        this.game.toRoom(m.npc.roomId, c.dim(line));
        shown = true;
      }
      this.game.combat.removeMob(m);
    }
  }

  /** Someone died: an ambush with no brigands left is over. */
  async onMobDeath(m: Mob, _killer: PlayerState | null): Promise<void> {
    for (const [pid, amb] of this.ambushes) {
      if (!amb.mobs.includes(m.id)) continue;
      if (!this.ambushersHere(amb).some((o) => o !== m)) this.ambushes.delete(pid);
    }
  }

  /** Housekeeping: lights burn out, ambushes give up on people who left, the barrow's guardian lies down again. */
  tick(now = Date.now()): void {
    for (const st of this.game.combat.players.values()) {
      if (st.lightUntil && st.lightUntil <= now) {
        st.lightUntil = 0;
        this.game.sessionOf(st.id)?.out(c.dim('Your light gutters and goes out.'));
      }
    }
    for (const [pid, amb] of this.ambushes) {
      const where = this.game.playerRoom(pid);
      if (where !== 'brigands_bend' && now - amb.at > 2 * 60_000) this.clearAmbush(pid, 'The brigands give up waiting and slip back into the holly.');
    }
    const busy = new Set([...this.ambushes.values()].flatMap((a) => a.mobs));
    for (const [id, at] of this.ambushMobs) {
      const m = this.game.combat.mobs.get(id);
      if (!m) this.ambushMobs.delete(id);
      else if (!m.target && !busy.has(id) && now - at > 2 * 60_000) {
        this.game.toRoom(m.npc.roomId, c.dim(`${capitalize(this.game.combat.mobName(m))} slips away into the trees.`));
        this.game.combat.removeMob(m);
        this.ambushMobs.delete(id);
      }
    }
    for (const m of [...this.game.combat.mobs.values()]) {
      if (m.kind === 'wight' && !m.target && now - this.wightAt > 10 * 60_000) {
        this.game.toRoom(m.npc.roomId, c.dim('The wight lies down again in the dark, and is only bones.'));
        this.game.combat.removeMob(m);
      }
    }
  }

  /** For tests: is an ambush waiting for this player? */
  ambushFor(playerId: number): Ambush | undefined {
    return this.ambushes.get(playerId);
  }

  ghostFor(playerId: number): boolean {
    return (this.ghost.get(playerId) ?? 0) > Date.now();
  }
}
