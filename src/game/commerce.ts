import type { ActionType, NpcTurnOutput, TradeContext } from '../npc/brain.js';
import { query } from '../db/pool.js';
import {
  balances,
  buyRange,
  claimScavenge,
  createItem,
  deleteItem,
  getFlag,
  getStanding,
  groupNames,
  itemsOf,
  moveCoin,
  moveItem,
  NotEnough,
  nudgeStanding,
  PACK_LIMIT,
  purseOf,
  sellRange,
  setFlag,
  spendPurse,
  tx,
  type Catalog,
  type Item,
  type ItemAction,
} from './economy.js';
import type { Session } from './session.js';
import { c, capitalize } from './text.js';
import { cleanTarget, looseMatch, type Npc } from './world.js';
import type { ShopSeed } from '../db/migrate.js';

/** What the commerce code needs from the game. */
export interface GameHooks {
  world: {
    npcsIn(roomId: string): Npc[];
    findNpc(roomId: string, word: string): Npc | undefined;
    room(id: string): { id: string; title: string };
    path(from: string, to: string): string[] | null;
  };
  playersIn(roomId: string, except?: Session): Session[];
  toRoom(roomId: string, text: string, except?: Session, except2?: Session): void;
  npcRespond(
    s: Session,
    npc: Npc,
    line: string,
    kind?: 'say' | 'event',
    trade?: TradeContext,
  ): Promise<NpcTurnOutput | null>;
  updateStatus(s: Session): void;
}

export interface Haggle {
  npcId: string;
  itemId: number; // buy: the shop's item. sell: the player's item
  templateId: string;
  mode: 'buy' | 'sell';
  floor: number;
  ceiling: number;
  current: number; // the NPC's price on the table
  offer: number | null;
  expires: number;
}

const HAGGLE_MS = 2 * 60_000;
const SERVICE_BLOCK_MS = 10 * 60_000;
const JOB_PAY = 3;
const JOB_COOLDOWN_MS = 60 * 60_000;
const JOB_EXPIRES_MS = 30 * 60_000;
const NEW_CHAR_GIVE_MS = 60 * 60_000;
const WITHDRAW_FEE_PER = 20;

/** Finds an item by what the player typed: name, keyword, or "2.rope" for the second one. */
export function findItem(items: Item[], typed: string): Item | undefined {
  let t = cleanTarget(typed);
  if (!t) return undefined;
  let nth = 1;
  const m = typed.trim().match(/^(\d+)\.(.+)$/);
  if (m) {
    nth = Number(m[1]);
    t = cleanTarget(m[2]);
  }
  const hits = items.filter((i) => {
    const name = i.template.name.toLowerCase();
    const padded = ` ${t} `;
    return (
      name === t ||
      name.endsWith(` ${t}`) ||
      name.replace(/^(a|an|the|some) /, '') === t ||
      i.template.keywords.some((k) => k === t || padded.includes(` ${k} `) || (t.length >= 3 && k.startsWith(t)))
    );
  });
  if (hits.length) return hits[nth - 1];
  // Nothing exact: the closest single match among these items, forgiving partial words and typos.
  const loose = looseMatch(m ? m[2] : typed, items.map((i) => ({ name: i.template.name, keywords: i.template.keywords, ref: i })));
  return loose && 'ref' in loose ? loose.ref : undefined;
}

function parseAmount(text: string): number | null {
  const m = text.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000 ? n : null;
}

export class Commerce {
  haggles = new Map<number, Haggle>();
  private blocked = new Map<string, number>();

  constructor(
    private game: GameHooks,
    public catalog: Catalog,
  ) {}

  // ------------------------------------------------------------------ helpers

  private shopHere(s: Session): { shop: ShopSeed; npc: Npc } | null {
    for (const npc of this.game.world.npcsIn(s.player!.roomId)) {
      const shop = this.catalog.shops.get(npc.id);
      if (shop) return { shop, npc };
    }
    return null;
  }

  private isBlocked(npcId: string, playerId: number): boolean {
    return (this.blocked.get(`${npcId}:${playerId}`) ?? 0) > Date.now();
  }

  private haggleFor(s: Session): Haggle | null {
    const h = this.haggles.get(s.player!.id);
    if (!h) return null;
    const npc = this.game.world.npcsIn(s.player!.roomId).find((n) => n.id === h.npcId);
    if (!npc || h.expires < Date.now()) {
      this.haggles.delete(s.player!.id);
      return null;
    }
    return h;
  }

  /** Drops any open haggle, for example when the player walks out. */
  closeHaggle(playerId: number): void {
    this.haggles.delete(playerId);
  }

  private name(npc: Npc): string {
    return npc.name;
  }

  private tradeContext(h: Haggle): TradeContext {
    return {
      mode: h.mode,
      item: this.catalog.template(h.templateId).name,
      floor: h.floor,
      ceiling: h.ceiling,
      current: h.current,
      offer: h.offer,
    };
  }

  /** Coin and pack weight in the status bar. */
  async status(s: Session): Promise<{ coin: number }> {
    const { coin } = await balances(s.player!.id);
    return { coin };
  }

  // ------------------------------------------------------------------ inventory

  async inventory(s: Session): Promise<void> {
    const items = await itemsOf(this.catalog, { type: 'player', id: s.player!.id });
    const { coin, bank } = await balances(s.player!.id);
    s.out(c.title('You are carrying:'));
    if (!items.length) s.out('  Nothing but lint and regret.');
    for (const n of groupNames(items)) s.out(`  ${c.thing(n)}`);
    s.out(`Coin: ${c.player(String(coin))}${bank ? c.dim(`  (banked: ${bank})`) : ''}   Load: ${this.weightOf(items)}/${PACK_LIMIT}`);
  }

  private weightOf(items: Item[]): number {
    return items.reduce((w, i) => w + i.template.weight, 0);
  }

  async roomItems(roomId: string): Promise<Item[]> {
    return itemsOf(this.catalog, { type: 'room', id: roomId });
  }

  async myItems(s: Session): Promise<Item[]> {
    return itemsOf(this.catalog, { type: 'player', id: s.player!.id });
  }

  /** take <item> from the floor. Returns false if nothing matched, so the caller can try room things. */
  async take(s: Session, rest: string): Promise<boolean> {
    const p = s.player!;
    const target = rest.replace(/^up\s+/i, '');
    const floor = await this.roomItems(p.roomId);
    const all = /^all\b/i.test(cleanTarget(target));
    const picks = all ? floor : [findItem(floor, target)].filter((i): i is Item => !!i);
    if (!picks.length) return false;
    let load = this.weightOf(await this.myItems(s));
    let took = 0;
    for (const item of picks) {
      if (load + item.template.weight > PACK_LIMIT) {
        s.out(`${capitalize(item.template.name)} won't fit. Your pack is full.`);
        break;
      }
      const ok = await tx((cl) => moveItem(cl, item.id, { type: 'room', id: p.roomId }, { type: 'player', id: p.id }));
      if (!ok) {
        s.out(`Someone got to ${item.template.name} before you.`);
        continue;
      }
      load += item.template.weight;
      took++;
      s.out(`You take ${item.template.name}.`);
      this.game.toRoom(p.roomId, `${c.player(p.name)} picks up ${item.template.name}.`, s);
    }
    if (all && !took && picks.length) s.out('You take nothing.');
    return true;
  }

  async drop(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    if (!rest) return s.out('Drop what?');
    const coinAmt = /coins?\b/i.test(rest) ? parseAmount(rest) : null;
    if (coinAmt) return s.out("You keep your coin. Drop it in Gallowmere and it's gone before it lands.");
    const item = findItem(await this.myItems(s), rest);
    if (!item) return s.out("You aren't carrying that.");
    if (item.template.kind === 'job') return s.out("Maud would skin you. Give it to her instead.");
    const ok = await tx((cl) => moveItem(cl, item.id, { type: 'player', id: p.id }, { type: 'room', id: p.roomId }));
    if (!ok) return s.out("You aren't carrying that anymore.");
    s.out(`You drop ${item.template.name}.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} drops ${item.template.name}.`, s);
  }

  /** eat, drink, light, read, use, open, smell on something in your pack. False when no item matched. */
  async itemAction(s: Session, verb: string, rest: string): Promise<boolean> {
    if (!rest) return false;
    const item = findItem(await this.myItems(s), rest);
    if (!item) return false;
    const p = s.player!;
    const raw = item.template.actions[verb] ?? (verb === 'drink' ? item.template.actions.use : undefined);
    if (!raw) {
      const can = Object.keys(item.template.actions);
      s.out(
        verb === 'eat' || verb === 'drink'
          ? `You can't ${verb} ${item.template.name}.`
          : `Nothing happens.${can.length ? c.dim(` Try: ${can.join(', ')}.`) : ''}`,
      );
      return true;
    }
    const a: ItemAction = typeof raw === 'string' ? { text: raw } : raw;
    if (a.consume) {
      const ok = await tx((cl) => deleteItem(cl, item.id, { type: 'player', id: p.id }));
      if (!ok) return true;
    }
    s.out(a.text);
    const seen = { eat: 'eats', drink: 'drinks', light: 'lights', read: 'reads', use: 'uses', open: 'opens', smell: 'sniffs' }[verb] ?? 'fiddles with';
    this.game.toRoom(p.roomId, `${c.player(p.name)} ${seen} ${item.template.name}.`, s);
    return true;
  }

  /** look at an item in your pack or on the floor. False when nothing matched. */
  async lookItem(s: Session, rest: string): Promise<boolean> {
    const item = findItem(await this.myItems(s), rest) ?? findItem(await this.roomItems(s.player!.roomId), rest);
    if (!item) return false;
    s.out(item.template.look);
    const verbs = Object.keys(item.template.actions);
    s.out(c.dim(`Weight ${item.template.weight}.${verbs.length ? ` You could: ${verbs.join(', ')}.` : ''}`));
    return true;
  }

  // ------------------------------------------------------------------ give

  async give(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const m = rest.match(/^(.+?)\s+to\s+(.+)$/i);
    if (!m) return s.out('Give what to whom? Try: give 2 coins to morda, or give bread to bob');
    const [, what, whoRaw] = m;
    const who = cleanTarget(whoRaw);
    const npc = this.game.world.findNpc(p.roomId, who);
    const other = npc ? undefined : this.game.playersIn(p.roomId, s).find((o) => o.player!.name.toLowerCase().startsWith(who.split(' ')[0]));
    if (!npc && !other) return s.out("There's nobody like that here.");
    const toName = npc ? npc.card.listName ?? npc.name : other!.player!.name;

    const amount = /\bcoins?\b|\bcopper/i.test(what) || /^\d+$/.test(what.trim()) ? parseAmount(what) : null;
    if (amount) {
      const { rows } = await query('SELECT created_at FROM players WHERE id = $1', [p.id]);
      if (other && Date.now() - new Date(rows[0].created_at).getTime() < NEW_CHAR_GIVE_MS) {
        return s.out("You're too new here to be handing out coin. Give it an hour.");
      }
      try {
        await tx(async (cl) => {
          await moveCoin(cl, p.id, -amount, 0, other ? `give:player:${other.player!.id}` : `give:npc:${npc!.id}`);
          if (other) await moveCoin(cl, other.player!.id, amount, 0, `gift:player:${p.id}`);
        });
      } catch (err) {
        if (err instanceof NotEnough) return s.out("You don't have that much coin.");
        throw err;
      }
      s.out(`You give ${amount} coin to ${toName}.`);
      this.game.toRoom(p.roomId, `${c.player(p.name)} gives some coin to ${toName}.`, s, other);
      if (other) {
        other.out(`${c.player(p.name)} gives you ${amount} coin.`);
        this.game.updateStatus(other);
      }
      this.game.updateStatus(s);
      if (npc) {
        if (amount >= 2) await nudgeStanding(npc.id, p.id, 1, true);
        await this.game.npcRespond(s, npc, `hands you ${amount} coin as a gift, asking nothing for it`, 'event');
      }
      return;
    }

    const item = findItem(await this.myItems(s), what);
    if (!item) return s.out("You aren't carrying that.");

    if (other) {
      const theirs = await itemsOf(this.catalog, { type: 'player', id: other.player!.id });
      if (this.weightOf(theirs) + item.template.weight > PACK_LIMIT) return s.out(`${other.player!.name} can't carry any more.`);
      const ok = await tx((cl) => moveItem(cl, item.id, { type: 'player', id: p.id }, { type: 'player', id: other.player!.id }));
      if (!ok) return s.out("You aren't carrying that anymore.");
      s.out(`You give ${item.template.name} to ${toName}.`);
      other.out(`${c.player(p.name)} gives you ${item.template.name}.`);
      this.game.toRoom(p.roomId, `${c.player(p.name)} gives ${item.template.name} to ${toName}.`, s, other);
      return;
    }

    // Giving to an NPC: Maud's job sack, or a gift.
    if (item.template.id === 'turnip_sack') return this.deliverSack(s, npc!, item);
    if (item.template.kind === 'job') return s.out(`${npc!.name} doesn't want that.`);
    const ok = await tx((cl) => deleteItem(cl, item.id, { type: 'player', id: p.id }));
    if (!ok) return s.out("You aren't carrying that anymore.");
    s.out(`You give ${item.template.name} to ${toName}.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} gives ${item.template.name} to ${toName}.`, s);
    if (npc!.kind === 'ai') {
      if (item.template.price >= 2) await nudgeStanding(npc!.id, p.id, 1, true);
      await this.game.npcRespond(s, npc!, `hands you ${item.template.name} as a gift`, 'event');
    } else {
      await this.game.npcRespond(s, npc!, 'thanks');
    }
  }

  // ------------------------------------------------------------------ odd job

  async work(s: Session): Promise<void> {
    const p = s.player!;
    const maud = this.game.world.npcsIn(p.roomId).find((n) => n.id === 'maud');
    if (!maud) {
      const path = this.game.world.path(p.roomId, 'maud_shop');
      return s.out(`Looking for work? Maud Cumin at Market East pays for hauling.${path ? c.dim(` From here: ${path.join(', ')}.`) : ''}`);
    }
    const job = await getFlag(p.id, 'job:maud');
    const age = job ? Date.now() - new Date(job.at).getTime() : Infinity;
    if (job?.value === 'active' && age < JOB_EXPIRES_MS) {
      return s.out(`Maud taps the counter. "My sack. Fish market. Still waiting."`);
    }
    if (job?.value === 'done' && age < JOB_COOLDOWN_MS) {
      const mins = Math.ceil((JOB_COOLDOWN_MS - age) / 60_000);
      return s.out(`Maud doesn't look up. "Nothing yet. Come back in ${mins} minutes."`);
    }
    await setFlag(p.id, 'job:maud', 'active');
    await createItem(null, 'turnip_sack', { type: 'room', id: 'fish_market' });
    const path = this.game.world.path('maud_shop', 'fish_market');
    s.out(
      `Maud jabs a thumb toward the river. "Sack of turnips at the fish market with my name on it. Bring it here, give it to me, ${JOB_PAY} coin. Drop it in the river and you owe me the turnips."`,
    );
    if (path) s.out(c.dim(`The fish market from here: ${path.join(', ')}. Then: take sack, come back, give sack to maud.`));
    this.game.toRoom(p.roomId, `${c.player(p.name)} takes on an errand for Maud.`, s);
  }

  private async deliverSack(s: Session, npc: Npc, item: Item): Promise<void> {
    const p = s.player!;
    if (npc.id !== 'maud') return s.out(`${npc.name} looks at the sack, then at you. "Not mine."`);
    const job = await getFlag(p.id, 'job:maud');
    if (job?.value !== 'active') return s.out(`Maud squints. "I didn't send you for that. Whose is it?" She takes it anyway, and pays you nothing.`);
    await tx(async (cl) => {
      if (!(await deleteItem(cl, item.id, { type: 'player', id: p.id }))) throw new NotEnough();
      await moveCoin(cl, p.id, JOB_PAY, 0, 'job:maud');
    });
    await setFlag(p.id, 'job:maud', 'done');
    await nudgeStanding('maud', p.id, 1, true);
    s.out(`You hand over the sack. Maud counts out ${JOB_PAY} coin, slowly, as if each one hurts. "Again in an hour, if you want it."`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} hands Maud a sack of turnips and gets paid.`, s);
    this.game.updateStatus(s);
  }

  // ------------------------------------------------------------------ scavenging

  async scavenge(s: Session, spot: string, text: string, table: string[]): Promise<void> {
    const p = s.player!;
    s.out(text);
    if (!(await claimScavenge(p.id, spot))) {
      return s.out("You've already picked this over. Give it an hour for the town to drop more.");
    }
    const pick = table[Math.floor(Math.random() * table.length)];
    if (pick === 'lost_copper') {
      await tx((cl) => moveCoin(cl, p.id, 1, 0, `scavenge:${spot}`));
      s.out(`You find a lost copper. ${c.dim('+1 coin')}`);
      this.game.updateStatus(s);
      return;
    }
    const t = this.catalog.template(pick);
    const load = this.weightOf(await this.myItems(s));
    if (load + t.weight > PACK_LIMIT) {
      await createItem(null, pick, { type: 'room', id: p.roomId });
      return s.out(`You find ${t.name}, but your pack is full. You leave it at your feet.`);
    }
    await createItem(null, pick, { type: 'player', id: p.id });
    s.out(`You find ${t.name}.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} digs something out of the muck.`, s);
  }

  // ------------------------------------------------------------------ shops

  async list(s: Session): Promise<void> {
    const here = this.shopHere(s);
    if (!here) return s.out("There's nobody selling anything here.");
    const { shop, npc } = here;
    const p = s.player!;
    const stock = await itemsOf(this.catalog, { type: 'shop', id: npc.id });
    const standing = await getStanding(npc.id, p.id);
    s.out(c.title(`${npc.card.listName ?? npc.name} sells:`));
    if (!stock.length) s.out('  Nothing. Sold out.');
    const seen = new Map<string, number>();
    for (const i of stock) seen.set(i.template.id, (seen.get(i.template.id) ?? 0) + 1);
    for (const [tid, n] of seen) {
      const t = this.catalog.template(tid);
      const { ceiling } = sellRange(t.price, shop.sellBand, standing);
      s.out(`  ${c.thing(t.name.padEnd(30))} ${String(ceiling).padStart(3)} coin  ${c.dim(`(${n} left)`)}`);
    }
    const buys = shop.buys.length ? `Buys: ${shop.buys.join(', ')}.` : 'Buys nothing.';
    s.out(c.dim(`${buys} ${shop.haggle ? 'buy <item> for <price> to haggle.' : 'Fixed prices, no haggling.'}`));
  }

  async appraise(s: Session, rest: string): Promise<void> {
    const here = this.shopHere(s);
    if (!here) return s.out('Nobody here would give you a price.');
    const item = findItem(await this.myItems(s), rest);
    if (!item) return s.out("You aren't carrying that.");
    const { shop, npc } = here;
    if (!this.buysKind(shop, item)) return s.out(`${npc.name} doesn't deal in that.`);
    const { floor } = buyRange(item.template.price, shop.buyBand, await getStanding(npc.id, s.player!.id));
    s.out(`${npc.name} turns ${item.template.name} over. "${floor} coin. Maybe."`);
  }

  private buysKind(shop: ShopSeed, item: Item): boolean {
    return item.template.price > 0 && item.template.kind !== 'job' && shop.buys.includes(item.template.kind);
  }

  /** buy <item> [for <price>] */
  async buy(s: Session, rest: string): Promise<void> {
    const here = this.shopHere(s);
    if (!here) return s.out("There's nobody selling anything here.");
    const { shop, npc } = here;
    const p = s.player!;
    if (this.isBlocked(npc.id, p.id)) return s.out(`${npc.name} won't serve you. Not today.`);
    const m = rest.match(/^(.+?)(?:\s+for\s+(\d+)(?:\s*coins?)?)?$/i);
    if (!m || !m[1].trim()) return s.out('Buy what? Type list to see what is for sale.');
    const stock = await itemsOf(this.catalog, { type: 'shop', id: npc.id });
    const item = findItem(stock, m[1]);
    if (!item) return s.out(`${npc.name} doesn't have that. Type list.`);
    const offer = m[2] ? Number(m[2]) : null;

    let h = this.haggleFor(s);
    if (!h || h.mode !== 'buy' || h.templateId !== item.template.id) {
      const standing = await getStanding(npc.id, p.id);
      const r = sellRange(item.template.price, shop.sellBand, standing);
      h = { npcId: npc.id, itemId: item.id, templateId: item.template.id, mode: 'buy', floor: r.floor, ceiling: r.ceiling, current: r.ceiling, offer: null, expires: Date.now() + HAGGLE_MS };
    }
    h.itemId = item.id;
    if (offer === null || offer >= h.current) return this.completeBuy(s, npc, h, h.current);
    if (!shop.haggle) return s.out(`${npc.name} doesn't haggle. "Price is ${h.current}."`);
    h.offer = offer;
    this.haggles.set(p.id, h);
    s.out(`You offer ${offer} coin for ${item.template.name}.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} haggles with ${npc.name} over ${item.template.name}.`, s);
    await this.haggleTurn(s, npc, h, `I'll give you ${offer} for ${item.template.name}.`);
  }

  /** sell <item> [for <price>] */
  async sell(s: Session, rest: string): Promise<void> {
    const here = this.shopHere(s);
    if (!here) return s.out('Nobody here is buying.');
    const { shop, npc } = here;
    const p = s.player!;
    if (this.isBlocked(npc.id, p.id)) return s.out(`${npc.name} won't deal with you. Not today.`);
    const m = rest.match(/^(.+?)(?:\s+for\s+(\d+)(?:\s*coins?)?)?$/i);
    if (!m || !m[1].trim()) return s.out('Sell what?');
    const item = findItem(await this.myItems(s), m[1]);
    if (!item) return s.out("You aren't carrying that.");
    if (!this.buysKind(shop, item)) return s.out(`${npc.name} doesn't deal in that.`);
    const ask = m[2] ? Number(m[2]) : null;

    let h = this.haggleFor(s);
    if (!h || h.mode !== 'sell' || h.itemId !== item.id) {
      const standing = await getStanding(npc.id, p.id);
      const r = buyRange(item.template.price, shop.buyBand, standing);
      h = { npcId: npc.id, itemId: item.id, templateId: item.template.id, mode: 'sell', floor: r.floor, ceiling: r.ceiling, current: r.floor, offer: null, expires: Date.now() + HAGGLE_MS };
    }
    if (ask === null || ask <= h.current) return this.completeSell(s, npc, h, h.current);
    if (!shop.haggle) return s.out(`${npc.name} doesn't haggle. "${h.current}, take it or leave it."`);
    h.offer = ask;
    this.haggles.set(p.id, h);
    s.out(`You ask ${ask} coin for ${item.template.name}.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} haggles with ${npc.name} over ${item.template.name}.`, s);
    await this.haggleTurn(s, npc, h, `I want ${ask} for ${item.template.name}.`);
  }

  /** offer <amount> during a haggle. */
  async offer(s: Session, rest: string): Promise<void> {
    const h = this.haggleFor(s);
    if (!h) return s.out("You aren't haggling with anyone. Try: buy rope for 3");
    const n = parseAmount(rest);
    if (!n) return s.out('Offer how much?');
    const npc = this.game.world.npcsIn(s.player!.roomId).find((x) => x.id === h.npcId)!;
    h.expires = Date.now() + HAGGLE_MS;
    if (h.mode === 'buy' && n >= h.current) return this.completeBuy(s, npc, h, h.current);
    if (h.mode === 'sell' && n <= h.current) return this.completeSell(s, npc, h, h.current);
    h.offer = n;
    s.out(h.mode === 'buy' ? `You offer ${n} coin.` : `You ask ${n} coin.`);
    await this.haggleTurn(s, npc, h, h.mode === 'buy' ? `How about ${n}?` : `I'll take ${n}, no less.`);
  }

  async accept(s: Session): Promise<void> {
    const h = this.haggleFor(s);
    if (!h) return s.out("There's no deal on the table.");
    const npc = this.game.world.npcsIn(s.player!.roomId).find((x) => x.id === h.npcId)!;
    return h.mode === 'buy' ? this.completeBuy(s, npc, h, h.current) : this.completeSell(s, npc, h, h.current);
  }

  async walkAway(s: Session): Promise<void> {
    const h = this.haggleFor(s);
    if (!h) return s.out("You aren't haggling with anyone.");
    this.haggles.delete(s.player!.id);
    const npc = this.game.world.npcsIn(s.player!.roomId).find((x) => x.id === h.npcId)!;
    s.out(`You walk away from the deal.`);
    this.game.toRoom(s.player!.roomId, `${c.player(s.player!.name)} walks away from ${npc.name}'s price.`, s);
  }

  /** The player talked to a shopkeeper mid haggle: the AI answers with the haggle attached. */
  async haggleTalk(s: Session, npc: Npc, line: string): Promise<boolean> {
    const h = this.haggleFor(s);
    if (!h || h.npcId !== npc.id || npc.kind !== 'ai') return false;
    h.expires = Date.now() + HAGGLE_MS;
    await this.haggleTurn(s, npc, h, line);
    return true;
  }

  /** One round with the AI. Whatever it says, the engine decides the price that stands. */
  private async haggleTurn(s: Session, npc: Npc, h: Haggle, line: string): Promise<void> {
    const p = s.player!;
    const out = npc.kind === 'ai' ? await this.game.npcRespond(s, npc, line, 'say', this.tradeContext(h)) : null;
    const action = out?.action.type ?? 'none';
    const fromAi = out && out.source !== 'scripted';

    if (action === 'refuse_service') {
      this.haggles.delete(p.id);
      this.blocked.set(`${npc.id}:${p.id}`, Date.now() + SERVICE_BLOCK_MS);
      await nudgeStanding(npc.id, p.id, -1);
      return s.out(c.dim(`${npc.name} won't trade with you for a while.`));
    }
    if (action === 'end_haggle') {
      this.haggles.delete(p.id);
      return s.out(c.dim(`${npc.name} is done haggling. The price was ${h.current} coin.`));
    }
    if (action === 'accept_price' && h.offer !== null) {
      const ok = h.mode === 'buy' ? h.offer >= h.floor : h.offer <= h.ceiling;
      if (ok) return h.mode === 'buy' ? this.completeBuy(s, npc, h, h.offer) : this.completeSell(s, npc, h, h.offer);
    }

    let next: number;
    if (action === 'offer_price' && out?.action.price !== undefined) {
      next = out.action.price;
    } else if (fromAi && action !== 'accept_price') {
      // The AI talked but named no price: the price stands.
      next = h.current;
    } else {
      // No AI, or an accept that didn't hold: meet partway, by formula.
      next = h.mode === 'buy' ? Math.ceil((h.current + Math.max(h.offer ?? h.floor, h.floor)) / 2) : Math.floor((h.current + Math.min(h.offer ?? h.ceiling, h.ceiling)) / 2);
    }
    // Clamp to what the engine allows, and log if the model tried to go outside it.
    const lo = h.mode === 'buy' ? Math.max(h.floor, h.offer ?? h.floor) : h.current;
    const hi = h.mode === 'buy' ? h.current : Math.min(h.ceiling, h.offer ?? h.ceiling);
    const clamped = Math.min(hi, Math.max(lo, next));
    if (clamped !== next && action === 'offer_price') {
      await query('INSERT INTO flagged_lines (player_id, source, text) VALUES ($1,$2,$3)', [p.id, `price:${npc.id}`, `model offered ${next}, clamped to ${clamped} (range ${lo} to ${hi})`]);
    }
    h.current = clamped;
    if (h.offer !== null && ((h.mode === 'buy' && clamped <= h.offer) || (h.mode === 'sell' && clamped >= h.offer))) {
      return h.mode === 'buy' ? this.completeBuy(s, npc, h, h.offer) : this.completeSell(s, npc, h, h.offer);
    }
    if (!fromAi) {
      s.out(c.npc(h.mode === 'buy' ? `${npc.name} sucks a tooth. "${clamped}, and that's me being soft."` : `${npc.name} sniffs. "${clamped}. Not a copper more."`));
    }
    s.out(c.dim(`${npc.name}'s price: ${clamped} coin. Type accept, offer <amount>, or walk away.`));
  }

  private async completeBuy(s: Session, npc: Npc, h: Haggle, price: number): Promise<void> {
    const p = s.player!;
    this.haggles.delete(p.id);
    const t = this.catalog.template(h.templateId);
    const load = this.weightOf(await this.myItems(s));
    if (load + t.weight > PACK_LIMIT) return s.out(`${capitalize(t.name)} won't fit in your pack.`);
    try {
      await tx(async (cl) => {
        await moveCoin(cl, p.id, -price, 0, `buy:${npc.id}:${t.id}`);
        if (!(await moveItem(cl, h.itemId, { type: 'shop', id: npc.id }, { type: 'player', id: p.id }))) throw new Error('gone');
      });
    } catch (err) {
      if (err instanceof NotEnough) return s.out(`You can't afford ${price} coin.`);
      return s.out(`${npc.name} has just sold the last one.`);
    }
    await nudgeStanding(npc.id, p.id, 1, true);
    s.out(`You buy ${t.name} for ${price} coin.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} buys ${t.name} from ${npc.name}.`, s);
    this.game.updateStatus(s);
  }

  private async completeSell(s: Session, npc: Npc, h: Haggle, price: number): Promise<void> {
    const p = s.player!;
    this.haggles.delete(p.id);
    const shop = this.catalog.shops.get(npc.id)!;
    const t = this.catalog.template(h.templateId);
    const keeps = t.id in shop.sells;
    try {
      await tx(async (cl) => {
        if (!(await spendPurse(cl, npc.id, price))) throw new NotEnough();
        const moved = keeps
          ? await moveItem(cl, h.itemId, { type: 'player', id: p.id }, { type: 'shop', id: npc.id })
          : await deleteItem(cl, h.itemId, { type: 'player', id: p.id });
        if (!moved) throw new Error('gone');
        await moveCoin(cl, p.id, price, 0, `sell:${npc.id}:${t.id}`);
      });
    } catch (err) {
      if (err instanceof NotEnough) {
        return s.out(`${npc.name} pats an empty purse. "Spent out for today. Come back tomorrow." ${c.dim(`(${await purseOf(npc.id)} coin left today)`)}`);
      }
      return s.out("You aren't carrying that anymore.");
    }
    await nudgeStanding(npc.id, p.id, 1, true);
    s.out(`You sell ${t.name} to ${npc.name} for ${price} coin.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} sells ${t.name} to ${npc.name}.`, s);
    this.game.updateStatus(s);
  }

  // ------------------------------------------------------------------ bank

  private atBank(s: Session): boolean {
    return this.game.world.npcsIn(s.player!.roomId).some((n) => n.id === 'ingelram');
  }

  async deposit(s: Session, rest: string): Promise<void> {
    if (!this.atBank(s)) return this.notAtBank(s);
    const p = s.player!;
    const { coin } = await balances(p.id);
    const n = /all/i.test(rest) ? coin : parseAmount(rest);
    if (!n) return s.out(coin ? 'Deposit how much? Try: deposit 5, or deposit all' : 'You have no coin to deposit.');
    try {
      const b = await tx((cl) => moveCoin(cl, p.id, -n, n, 'bank:deposit'));
      s.out(`Ingelram weighs your ${n} coin twice and writes it down. Banked: ${b.bank}. In your purse: ${b.coin}.`);
    } catch (err) {
      if (err instanceof NotEnough) return s.out("You don't have that much.");
      throw err;
    }
    this.game.updateStatus(s);
  }

  async withdraw(s: Session, rest: string): Promise<void> {
    if (!this.atBank(s)) return this.notAtBank(s);
    const p = s.player!;
    const { bank } = await balances(p.id);
    if (!bank) return s.out('You have nothing banked.');
    let n = /all/i.test(rest) ? bank : parseAmount(rest);
    if (!n) return s.out(bank ? 'Withdraw how much? Try: withdraw 5, or withdraw all' : 'You have nothing banked.');
    // The fee comes out of what's banked. "all" means everything after the fee.
    let fee = Math.ceil(n / WITHDRAW_FEE_PER);
    if (/all/i.test(rest)) {
      fee = Math.ceil(bank / (WITHDRAW_FEE_PER + 1));
      n = bank - fee;
      if (n <= 0) return s.out('After the fee there would be nothing left.');
    }
    try {
      const b = await tx((cl) => moveCoin(cl, p.id, n!, -(n! + fee), 'bank:withdraw'));
      s.out(`Ingelram counts out ${n} coin and keeps ${fee} for his trouble. Banked: ${b.bank}. In your purse: ${b.coin}.`);
    } catch (err) {
      if (err instanceof NotEnough) return s.out(`You don't have that much banked, counting the fee of ${fee}.`);
      throw err;
    }
    this.game.updateStatus(s);
  }

  async balance(s: Session): Promise<void> {
    const { coin, bank } = await balances(s.player!.id);
    s.out(`In your purse: ${coin} coin. In the counting house: ${bank} coin.`);
  }

  private notAtBank(s: Session): void {
    const path = this.game.world.path(s.player!.roomId, 'counting_house');
    s.out(`That's done at the counting house, south of Market East.${path ? c.dim(` From here: ${path.join(', ')}.`) : ''}`);
  }

  // ------------------------------------------------------------------ bribes

  async bribe(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const m = rest.match(/^(\S+)\s+(\d+)/) ?? rest.match(/^(\d+)\s+(?:coins?\s+)?(?:to\s+)?(\S+)/);
    if (!m) return s.out('Bribe whom, with how much? Try: bribe dace 3');
    const [who, amt] = /^\d+$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const npc = this.game.world.findNpc(p.roomId, who);
    if (!npc) return s.out("There's nobody like that here.");
    const amount = Number(amt);
    const card = npc.card as { bribeFloor?: number; tips?: string[] };
    if (!card.bribeFloor || !card.tips) {
      s.out(`You hold out ${amount} coin to ${npc.name}.`);
      await this.game.npcRespond(s, npc, `holds out ${amount} coin as a bribe, which you would never take`, 'event');
      return;
    }
    const standing = await getStanding(npc.id, p.id);
    const floor = card.bribeFloor + Math.max(0, -standing);
    const { coin } = await balances(p.id);
    if (coin < amount) return s.out("You don't have that much coin.");
    if (amount < floor) {
      s.out(`You hold out ${amount} coin. ${npc.name} looks at it like it's something the dog brought in.`);
      await this.game.npcRespond(s, npc, `holds out a measly ${amount} coin as a bribe, which is an insult and you refuse it`, 'event');
      return;
    }
    await tx((cl) => moveCoin(cl, p.id, -amount, 0, `bribe:${npc.id}`));
    await nudgeStanding(npc.id, p.id, 1, true);
    this.game.updateStatus(s);
    const f = await getFlag(p.id, `tips:${npc.id}`);
    const idx = Number(f?.value ?? 0) % card.tips.length;
    await setFlag(p.id, `tips:${npc.id}`, String(idx + 1));
    s.out(`You slip ${amount} coin to ${npc.name}. It vanishes.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} and ${npc.name} shake hands, briefly.`, s);
    await this.game.npcRespond(s, npc, `quietly slips you ${amount} coin as a bribe. You take it and lean in to share a secret, which the narrator will tell them`, 'event');
    s.out(`${c.npc(npc.name)} leans in close: ${c.speech(`"${card.tips[idx]}"`)}`);
  }

  // ------------------------------------------------------------------ hint

  async hint(s: Session): Promise<void> {
    const p = s.player!;
    const roomId = p.roomId;
    const tips: string[] = [];
    const h = this.haggleFor(s);
    if (h) tips.push(`You're haggling. Type accept to take the price, offer <amount> to counter, or walk away.`);
    const job = await getFlag(p.id, 'job:maud');
    const mine = await this.myItems(s);
    if (job?.value === 'active') {
      if (mine.some((i) => i.template.id === 'turnip_sack')) {
        const path = this.game.world.path(roomId, 'maud_shop');
        tips.push(`Take the sack back to Maud and type give sack to maud.${path?.length ? ` Way: ${path.join(', ')}.` : ''}`);
      } else {
        const path = this.game.world.path(roomId, 'fish_market');
        tips.push(`Maud's sack is at the fish market. Type take sack there.${path?.length ? ` Way: ${path.join(', ')}.` : ''}`);
      }
    }
    const here = this.shopHere(s);
    if (here) tips.push(`${here.npc.name} trades here. Type list to see the goods, buy <item>, or sell <item>.`);
    if (this.atBank(s)) tips.push('Bank your coin here so the plague cart can never take it: deposit <amount>.');
    const ai = this.game.world.npcsIn(roomId).find((n) => n.kind === 'ai');
    if (ai) tips.push(`Talk to ${ai.name}: ' hello ${ai.card.keywords[0]}. They remember what you tell them.`);
    const { coin } = await balances(p.id);
    if (!tips.length && coin < 5 && job?.value !== 'active') {
      const path = this.game.world.path(roomId, 'maud_shop');
      tips.push(`Short on coin? Maud at Market East pays for work: go to her shop and type work.${path?.length ? ` Way: ${path.join(', ')}.` : ''}`);
    }
    if (!tips.length) {
      const general = [
        'Search the fish market slabs, the hulk, the market cellars or the midden in the Rat\'s yard for junk, then sell it to Tilly or Hook.',
        'Dace at the North Gate knows things. Bribe him: bribe dace 3.',
        'Coin in your pocket is at risk once the plague cart comes. Bank it with Ingelram, south of Market East.',
        'Everything listed under You see can be used. Look at a thing to see what it responds to.',
        'Hamo, Maud, Father Osmund and Morda all sell things. Haggle: buy rope for 3.',
      ];
      tips.push(general[Math.floor(Math.random() * general.length)]);
    }
    for (const t of tips.slice(0, 3)) s.out(c.dim(`Hint: ${t}`));
  }
}
