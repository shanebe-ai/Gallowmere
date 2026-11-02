// Something happens at night (Milestone 5). Once a night, with a 40 percent
// chance and someone online, code starts one event from a small table. Every
// reward is code; events never kill and never take a player's goods.

import { createItem, getFlag, moveCoin, setFlag, tx } from './economy.js';
import { c } from './text.js';
import { DAY_MS } from './weather.js';
import type { Game } from './game.js';
import type { Session } from './session.js';
import type { Npc } from './world.js';

export type EventKind = 'fire' | 'drowned' | 'axle' | 'stranger';
export const EVENT_KINDS: EventKind[] = ['fire', 'drowned', 'axle', 'stranger'];
const FIRE_ROOM = 'fish_market';
const WATER_ROOM = 'river_docks';
const FIRE_THROWS = 5;
const DROWNED_NAME = 'a drowned stranger';
const STASH_ROOMS = ['ew_hollow', 'ew_runs', 'ee_birches', 'ee_ditch', 'bw_oaks', 'bw_fallen'];
const STRANGER_ROOM = 'drowned_rat';
const CHARM_PRICE = 8;

interface Running {
  kind: EventKind;
  until: number;
  helpers: Map<number, number>; // fire: throws per player
  water: Set<number>; // fire: who has a full bucket
  thrown: number;
  looted: Set<number>; // axle: who has been through the cart
  bought: Set<number>; // stranger: who has a charm
}

export class NightEvents {
  current: Running | null = null;
  private rolledFor = -1;

  constructor(private game: Game, private rand: () => number = Math.random) {}

  /** The slow beat: maybe start tonight's event, and end one whose time is up. */
  async tick(now = Date.now()): Promise<void> {
    if (this.current && now >= this.current.until) return this.end(false);
    if (this.current || !this.game.weather.isNight()) return;
    const night = Math.floor(now / DAY_MS);
    if (this.rolledFor === night) return;
    this.rolledFor = night;
    if (this.game.onlineNames().length < 1 || this.rand() >= 0.4) return;
    await this.start(EVENT_KINDS[Math.floor(this.rand() * EVENT_KINDS.length)], now);
  }

  async start(kind: EventKind, now = Date.now()): Promise<void> {
    if (this.current) await this.end(false);
    const minutes = 20 + Math.floor(this.rand() * 21);
    this.current = { kind, until: now + minutes * 60_000, helpers: new Map(), water: new Set(), thrown: 0, looted: new Set(), bought: new Set() };
    switch (kind) {
      case 'fire':
        this.game.broadcast(c.error('A bell clangs down at the docks, and then shouting: FIRE! Smoke is rising over the fish market.'));
        this.game.soundAll('bell', true);
        this.game.toRoom(FIRE_ROOM, c.error('Flames climb a stack of crates and lick at the net loft above. Folk run past with nothing in their hands. Water from the river: fill bucket at the River Docks, throw water here.'));
        break;
      case 'drowned':
        await this.game.combat.makeCorpse('street', null, DROWNED_NAME, 'mere_shore', 0, [], 0);
        this.game.broadcast(c.dim('Word comes up the road from the forest: a body has washed up on the shore of the mere. Father Osmund will want it brought in.'));
        break;
      case 'axle':
        if (!this.game.cart.out) this.game.cart.bell();
        this.game.cart.breakDown();
        this.game.broadcast(c.dim('Somewhere in the streets there is a crack like a shot and a lot of swearing. The plague cart has broken an axle.'));
        break;
      case 'stranger': {
        const npc: Npc = {
          id: 'night_stranger', roomId: STRANGER_ROOM, name: 'a stranger from Vesna', kind: 'light',
          card: {
            keywords: ['stranger', 'traveller', 'traveler', 'vesna'],
            listName: 'a stranger from Vesna, dripping on the floor',
            short: 'A stranger in a lantern grey cloak sits by the fire, steaming gently.',
            look: 'A thin traveller in a grey cloak with a tin lantern at their belt. A name is painted on the lantern, too small to read.',
            job: 'a traveller from Vesna, passing through Gallowmere for one night, selling lantern charms',
            personality: 'quiet, polite, odd, speaks as if they already know you',
            knows: `Vesna lies at the end of the north road. Behind its outer ward is an inner gate that opens for nobody, and behind that the Lamp Hall and the Archive of Names. Old Jessamy paints names on lanterns; some say they are the names of people Vesna is waiting for. You sell lantern charms for ${CHARM_PRICE} coin: buy charm. You leave at first light.`,
            scripted: ['"Have you seen your name on a lantern yet? You will."', `"A lantern charm, ${CHARM_PRICE} coin. For the road north."`],
          },
        } as Npc;
        this.game.world.npcs.set(npc.id, npc);
        this.game.broadcast(c.dim('Someone has come in from the north road tonight: a stranger is drying off by the fire at the Drowned Rat.'));
        break;
      }
    }
  }

  async end(early: boolean): Promise<void> {
    const ev = this.current;
    if (!ev) return;
    this.current = null;
    switch (ev.kind) {
      case 'fire':
        if (!early) this.game.toRoom(FIRE_ROOM, c.dim('The fire burns itself out at last, leaving a black hole in the fish market and a smell that will last a week.'));
        break;
      case 'axle':
        this.game.cart.mend();
        this.game.broadcast(c.dim('Somebody has bodged the plague cart\'s axle with a fence post. It creaks on.'));
        break;
      case 'stranger':
        this.game.world.npcs.delete('night_stranger');
        this.game.toRoom(STRANGER_ROOM, c.dim('The stranger from Vesna pulls up their hood and goes out into the dark, north.'));
        break;
      case 'drowned':
        break;
    }
  }

  /** hint: is something going on? */
  hint(): string | null {
    const ev = this.current;
    if (!ev) return null;
    return {
      fire: 'There is a fire at the fish market. The river at the River Docks has water: fill bucket, then throw water at the fire.',
      drowned: 'A body has washed up on the mere shore. Father Osmund would want it brought to the nave.',
      axle: 'The plague cart is stuck in the street with a broken axle. Some say there are pickings on it, if no watchman sees.',
      stranger: 'A stranger from Vesna is drying off by the fire at the Drowned Rat tonight. They will be gone by morning.',
    }[ev.kind];
  }

  // -------------------------------------------------------------- the fire

  fill(s: Session): void {
    const ev = this.current;
    const p = s.player!;
    if (ev?.kind !== 'fire') return s.out('Fill what? There is nothing to fill it for.');
    if (p.roomId !== WATER_ROOM) return s.out('The river is at the River Docks, west of the fish market.');
    if (ev.water.has(p.id)) return s.out('Your bucket is already full. Throw it on the fire.');
    ev.water.add(p.id);
    s.out('You grab a leather bucket off the quay and haul it up full of black river water.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} hauls up a bucket of river water.`, s);
  }

  async throwWater(s: Session): Promise<void> {
    const ev = this.current;
    const p = s.player!;
    if (ev?.kind !== 'fire') return s.out('Throw what, at what?');
    if (p.roomId !== FIRE_ROOM) return s.out('The fire is at the fish market.');
    if (!ev.water.has(p.id)) return s.out('Your bucket is empty. Fill it at the river, at the River Docks.');
    ev.water.delete(p.id);
    ev.thrown++;
    ev.helpers.set(p.id, (ev.helpers.get(p.id) ?? 0) + 1);
    const left = FIRE_THROWS - ev.thrown;
    this.game.soundRoom(p.roomId, 'splash');
    s.out(left > 0 ? `You hurl the water into the flames. They hiss and fall back, and come again. ${left} more might do it.` : 'You hurl the last bucket and the fire dies in a great white roar of steam.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} throws a bucket of water on the fire.`, s);
    if (left > 0) return;
    // Out: the harbourmaster pays everyone who carried water.
    for (const [pid, throws] of ev.helpers) {
      const pay = 3 + 2 * throws;
      await tx((cl) => moveCoin(cl, pid, pay, 0, 'the harbourmaster, for the fire'));
      const who = this.game.sessionOf(pid);
      who?.out(c.system(`The harbourmaster, black with soot, presses ${pay} coin into your hand. "The whole quay would have gone. Thank you."`));
      if (who) this.game.updateStatus(who);
      const name = who?.player?.name;
      if (name) await this.game.town.rumour(pid, `${name} helped put out the fire at the fish market`);
    }
    this.game.broadcast(c.dim('The fire at the fish market is out. The docks stand.'));
    await this.end(true);
  }

  // -------------------------------------------------------------- the drowned stranger

  /** Called when a body is buried: the drowned stranger had something in a pocket. */
  async onBury(s: Session, name: string): Promise<void> {
    if (name !== DROWNED_NAME) return;
    const p = s.player!;
    const room = STASH_ROOMS[Math.floor(this.rand() * STASH_ROOMS.length)];
    await setFlag(p.id, 'stash', room);
    const title = this.game.world.rooms.get(room)?.title ?? 'the forest';
    s.out(c.system(`As Father Osmund straightens the drowned stranger's coat, a waxed packet slips from a pocket. Inside, in a careful hand: "Under the turned stone, ${title}. For whoever finds me." Osmund looks at you. "Well. It's yours to follow." Dig there.`));
    if (this.current?.kind === 'drowned') await this.end(true);
  }

  /** dig, where the drowned stranger's note says. True when it was the stash. */
  async dig(s: Session): Promise<boolean> {
    const p = s.player!;
    const flag = await getFlag(p.id, 'stash');
    if (!flag?.value || flag.value !== p.roomId) return false;
    await setFlag(p.id, 'stash', '');
    await tx(async (cl) => {
      await moveCoin(cl, p.id, 12, 0, 'the drowned stranger\'s stash');
      await createItem(cl, 'silver_locket', { type: 'player', id: p.id });
    });
    s.out(c.system('Under a turned stone, wrapped in oilcloth: twelve coins and a silver locket. Inside the locket, a painted face you do not know, and a name, very small. It is not yours. Not yet.'));
    this.game.updateStatus(s);
    await this.game.town.rumour(p.id, `${p.name} found what the drowned stranger left in the forest`);
    return true;
  }

  // -------------------------------------------------------------- the broken cart

  async lootCart(s: Session): Promise<void> {
    const ev = this.current;
    const p = s.player!;
    if (ev?.kind !== 'axle' || this.game.cart.room !== p.roomId) return s.out('There is no stuck cart here to go through.');
    if (ev.looted.has(p.id)) return s.out('You have had your pickings. The cart men are starting to look at you.');
    ev.looted.add(p.id);
    const coin = 1 + Math.floor(this.rand() * 4);
    await tx((cl) => moveCoin(cl, p.id, coin, 0, 'pickings off the plague cart'));
    s.out(`While the cart men argue over the axle, you go through the sacking. ${coin} coin, and something you would rather not have touched.`);
    this.game.updateStatus(s);
    await this.game.law.recordCrime(p.id, 'theft', p.roomId, 'the plague cart');
  }

  // -------------------------------------------------------------- the stranger

  /** buy charm, from the stranger. True when it was theirs to answer. */
  async buyCharm(s: Session, rest: string): Promise<boolean> {
    const p = s.player!;
    if (this.current?.kind !== 'stranger' || p.roomId !== STRANGER_ROOM || !/charm|lantern/i.test(rest)) return false;
    if (this.current.bought.has(p.id)) {
      s.out(c.npc('The stranger shakes their head. "One each. They know if you are greedy."'));
      return true;
    }
    try {
      await tx(async (cl) => {
        await moveCoin(cl, p.id, -CHARM_PRICE, 0, 'a lantern charm from the stranger');
        await createItem(cl, 'lantern_charm', { type: 'player', id: p.id });
      });
    } catch {
      s.out(c.npc(`"${CHARM_PRICE} coin," the stranger says, not unkindly. You do not have it.`));
      return true;
    }
    this.current.bought.add(p.id);
    s.out(c.npc('The stranger presses a tiny tin lantern into your palm, no bigger than a thimble. It is warm. "For the road north."'));
    this.game.updateStatus(s);
    return true;
  }
}
