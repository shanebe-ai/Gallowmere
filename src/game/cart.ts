// The plague cart: at a random time every hour or two the temple bell tolls, and a cart works
// its way through the streets taking the dead, the nearly dead, and a toll from everyone else.
// Everything here is code. The cart men never talk back.

import { query } from '../db/pool.js';
import { moveCoin, tx } from './economy.js';
import { MOBS } from './mobs.js';
import { c, capitalize } from './text.js';
import { maxHealthFor, type Combat } from './combat.js';
import type { Game } from './game.js';

/** The cart's round: from the temple steps, through every street, down to the river. */
export const ROUTE = [
  'temple_steps', 'gate_road', 'market_square', 'market_west', 'smithy_row', 'market_west', 'market_square',
  'market_east', 'butchers_alley', 'market_east', 'market_square', 'wet_lane', 'docks_stair', 'river_docks', 'fish_market',
];

export interface CartOptions {
  minMs?: number; // shortest wait between rounds
  maxMs?: number;
  warnMs?: number; // from the bell to the cart setting out
  stepMs?: number; // time in each room
}

export class PlagueCart {
  out = false; // the bell has rung and the cart isn't back yet
  room: string | null = null;
  nextBell = 0;
  private step = 0;
  /** Who has paid this round: the cart passes some rooms twice, but takes the toll once. */
  private tolled = new Set<number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private game: Game, private combat: Combat, private opts: CartOptions = {}) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private later(ms: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.error('plague cart failed:', e));
    }, ms);
    this.timer.unref();
  }

  /** Picks the next bell at random, between one and two hours away. */
  schedule(): void {
    const min = this.opts.minMs ?? 60 * 60_000;
    const max = this.opts.maxMs ?? 120 * 60_000;
    const wait = min + Math.floor(this.game.random() * (max - min));
    this.nextBell = Date.now() + wait;
    this.later(wait, () => this.bell());
  }

  /** The bell tolls: everyone hears, and the cart sets out a couple of minutes later. */
  bell(): void {
    if (this.out) return;
    this.out = true;
    this.step = 0;
    this.tolled.clear();
    this.room = null;
    this.game.broadcast(c.system("The temple bell tolls, slow and heavy. Somewhere a cart's wheels begin to turn."));
    this.later(this.opts.warnMs ?? 2 * 60_000, () => this.advance());
  }

  /** The cart moves to its next room and does its work there. */
  async advance(): Promise<void> {
    if (this.step >= ROUTE.length) return this.finish();
    const prev = this.room;
    const roomId = ROUTE[this.step++];
    this.room = roomId;
    if (prev && prev !== roomId) this.game.toRoom(prev, c.dim('The cart creaks on, its wheels dripping.'));
    this.game.toRoom(
      roomId,
      c.npc('The plague cart creaks into view, piled high with shapes under sacking. Two cart men walk beside it with hooks and lanterns. The driver does not look at you.'),
    );
    // The rooms around hear it coming.
    for (const near of this.game.world.room(roomId).exits) {
      if (near.to !== prev) this.game.toRoom(near.to, c.dim('Close by, the slow creak of cart wheels and the clink of a hand bell.'));
    }
    await this.work(roomId);
    this.later(this.opts.stepMs ?? 40_000, () => this.advance());
  }

  private finish(): void {
    if (this.room) this.game.toRoom(this.room, c.dim('The plague cart rattles away down to the river, and the street breathes again.'));
    this.game.broadcast(c.dim('Far off, the plague cart reaches the river. The town lets out its breath.'));
    this.out = false;
    this.room = null;
    this.schedule();
  }

  /** What the cart men do in one room. */
  async work(roomId: string): Promise<void> {
    // The badly hurt and the dead drunk are "mistaken for dead".
    for (const m of this.combat.mobsIn(roomId)) {
      if (!MOBS[m.kind].street || m.target) continue;
      if (m.passedOut || m.health < m.maxHealth / 3) {
        await this.combat.killMob(m, null, c.error(`The cart men take ${this.combat.mobName(m)} by the arms and legs and swing them up onto the cart. They don't check.`));
      }
    }
    for (const s of this.game.playersIn(roomId)) {
      const st = await this.combat.load(s.player!);
      if (this.combat.isNew(st)) {
        s.out(c.dim('One of the cart men looks you over, decides you are too fresh off the road to bother with, and walks on.'));
        continue;
      }
      const senseless = st.outUntil > Date.now() || (!!st.asleep && !st.asleep.rented);
      if (st.health < maxHealthFor(st.level) / 3 || senseless) {
        this.game.toRoom(
          roomId,
          c.error(senseless ? `The cart men find ${st.name} lying senseless in the road, take them for dead, and swing them up onto the cart.` : `The cart men seize ${st.name}, who is too hurt to stop them, and throw them on the cart.`),
          s,
        );
        await this.combat.killPlayer(
          st.id,
          null,
          undefined,
          senseless ? 'You wake to hooks in your coat and sacking over your face, and then the dark. The cart men do not check.' : 'Hooks catch your arms. You are too weak to fight them. The last thing you see is sacking, and then the dark.',
        );
        await this.game.town.rumour(st.id, `${st.name} was taken by the plague cart${senseless ? ', dead drunk or dead asleep, and the cart men never checked' : ''}`);
        continue;
      }
      if (this.tolled.has(st.id)) {
        s.out(c.dim('A cart man recognises you and walks on. You have paid once tonight.'));
        continue;
      }
      const { rows } = await query('SELECT coin FROM players WHERE id=$1', [st.id]);
      const toll = Math.floor((rows[0]?.coin ?? 0) / 4);
      this.tolled.add(st.id);
      if (toll > 0) {
        await tx((cl) => moveCoin(cl, st.id, -toll, 0, 'the plague cart toll'));
        s.out(c.error(`A cart man's hand goes into your purse before you can stop it, and comes out with ${toll} coin. "For the dead," he says. He doesn't say which dead.`));
        this.game.toRoom(roomId, c.dim(`A cart man helps himself to ${st.name}'s purse.`), s);
        this.game.updateStatus(s);
      } else {
        s.out(c.dim('A cart man looks at your purse, sees nothing worth the effort, and walks on.'));
      }
    }
    // Every body here goes on the cart, and what it carried goes to Hook.
    const bodies = await this.combat.corpsesIn(roomId);
    for (const k of bodies) {
      await tx(async (cl) => {
        await cl.query(`UPDATE items SET owner_type='shop', owner_id='hook' WHERE owner_type='corpse' AND owner_id=$1`, [String(k.id)]);
        await cl.query('DELETE FROM corpses WHERE id=$1', [k.id]);
      });
      this.game.toRoom(roomId, c.npc(`The cart men hook the corpse of ${k.name} up onto the cart without a word.`));
      if (k.kind === 'player' && k.playerId) {
        const owner = this.game.sessionOf(k.playerId);
        owner?.out(c.system('Far off, the plague cart takes your body. Whatever you had on it will be in Hook\'s back room by now.'));
      }
    }
  }

  /** For NPC prompts: what the town knows right now. */
  note(): string | undefined {
    if (!this.out) return undefined;
    return this.room ? `The plague cart is out in the streets right now, near ${capitalize(this.game.world.room(this.room).title)}.` : 'The temple bell has just tolled: the plague cart is about to set out.';
  }
}
