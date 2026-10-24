// Fighting, death and the street folk. Every roll, wound, death and coin is decided here, in code.
// The AI only ever adds a line of talk around a fight.

import { query } from '../db/pool.js';
import { createItem, deleteItem, itemsOf, moveCoin, moveItem, nudgeStanding, tx, type Item, type ItemTemplate } from './economy.js';
import { MOBS, SEWER_POP, STREET_MIX, generate, randBetween, type MobKind } from './mobs.js';
import type { Session } from './session.js';
import { c, capitalize } from './text.js';
import { DIRECTIONS, OPPOSITE, cleanTarget, looseMatch, type Direction, type Npc } from './world.js';
import type { Game } from './game.js';

export const TEMPLE = 'temple_of_ash';
export const NEW_PLAYER_MS = 2 * 60 * 60_000;
const CHILL_MS = 10 * 60_000;
const CORPSE_MS = 30 * 60_000;
const OWNER_ONLY_MS = 10 * 60_000;
const ALE_MS = 5 * 60_000;
const MAX_LEVEL = 10;
const CORPSE_WEIGHT = 15;
const MOB_RESPAWN_MS = 5 * 60_000;
const RAT_KING_RESPAWN_MS = 24 * 60 * 60_000;

export interface PlayerState {
  id: number;
  name: string;
  createdAt: number;
  level: number;
  xp: number;
  health: number;
  wielded: number | null;
  worn: number | null;
  chillUntil: number;
  aleUntil: number;
  target: string | null;
  lastFight: number;
  carrying: number | null; // a corpse id
  dirty: boolean;
}

export interface Mob {
  id: string;
  kind: MobKind;
  npc: Npc;
  level: number;
  health: number;
  maxHealth: number;
  coin: number;
  items: string[];
  target: string | null;
  nextMove: number;
  passedOut: number; // until when a drunk lies in the road
  home: string | null; // beasts stay where they were put
}

interface Fighter {
  key: string;
  name: string; // as others see it: "Wat Ditchwater" or "Shane"
  roomId: string;
  level: number;
  health: number;
  maxHealth: number;
  damage: [number, number];
  armour: number;
  hit2: string; // "punch": what you do
  hit3: string; // "punches": what they do
  aim: number; // modifier to hit, in percent
  extra: number; // extra damage per hit
}

export function maxHealthFor(level: number): number {
  return 20 + 5 * (level - 1);
}

export function xpForLevel(level: number): number {
  // Experience needed to reach this level from the start: 25, 100, 225 ...
  return 25 * (level - 1) * (level - 1);
}

/** How badly hurt someone looks, in words. */
export function woundWords(health: number, max: number): string {
  const f = health / max;
  if (f >= 0.95) return 'unhurt';
  if (f >= 0.75) return 'bruised';
  if (f >= 0.5) return 'hurt';
  if (f >= 0.3) return 'badly hurt';
  if (f >= 0.12) return 'bleeding badly';
  return 'barely standing';
}

/** What a weapon does, by its name: fists punch, a knife stabs. [you, they] */
function weaponVerb(t: ItemTemplate | null): [string, string] {
  if (!t) return ['punch', 'punches'];
  if (/sword/.test(t.id)) return ['slash', 'slashes'];
  if (/axe/.test(t.id)) return ['hack', 'hacks'];
  if (/knife/.test(t.id)) return ['stab', 'stabs'];
  return ['club', 'clubs'];
}

export class Combat {
  players = new Map<number, PlayerState>();
  mobs = new Map<string, Mob>();
  private nextId = 1;
  private tickTimer: NodeJS.Timeout | null = null;
  private lifeTimer: NodeJS.Timeout | null = null;
  private respawnAt = new Map<string, number>(); // "room:kind#n" -> when a beast comes back
  private lastRegen = Date.now();

  constructor(private game: Game, private opts: { tickMs?: number; lifeMs?: number; streetFolk?: number } = {}) {}

  private get r(): () => number {
    return () => this.game.random();
  }

  start(): void {
    this.tickTimer = setInterval(() => void this.tick().catch((e) => console.error('combat tick failed:', e)), this.opts.tickMs ?? 3000);
    this.tickTimer.unref();
    this.lifeTimer = setInterval(() => void this.life().catch((e) => console.error('street life failed:', e)), this.opts.lifeMs ?? 20_000);
    this.lifeTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.lifeTimer) clearInterval(this.lifeTimer);
  }

  // ---------------------------------------------------------------- players

  async load(p: { id: number; name: string; createdAt: Date }): Promise<PlayerState> {
    const existing = this.players.get(p.id);
    if (existing) return existing;
    const { rows } = await query(
      'SELECT level, xp, health, wielded_item, worn_item, chill_until FROM players WHERE id=$1',
      [p.id],
    );
    const r = rows[0];
    const carried = await query('SELECT id FROM corpses WHERE carried_by=$1 LIMIT 1', [p.id]);
    const st: PlayerState = {
      id: p.id,
      name: p.name,
      createdAt: new Date(p.createdAt).getTime(),
      level: r?.level ?? 1,
      xp: r?.xp ?? 0,
      health: Math.min(r?.health ?? 20, maxHealthFor(r?.level ?? 1)),
      wielded: r?.wielded_item != null ? Number(r.wielded_item) : null,
      worn: r?.worn_item != null ? Number(r.worn_item) : null,
      chillUntil: r?.chill_until ? new Date(r.chill_until).getTime() : 0,
      aleUntil: 0,
      target: null,
      lastFight: 0,
      carrying: carried.rows[0] ? Number(carried.rows[0].id) : null,
      dirty: false,
    };
    this.players.set(p.id, st);
    return st;
  }

  async save(id: number): Promise<void> {
    const st = this.players.get(id);
    if (!st) return;
    st.dirty = false;
    await query(
      'UPDATE players SET level=$2, xp=$3, health=$4, wielded_item=$5, worn_item=$6, chill_until=$7 WHERE id=$1',
      [id, st.level, st.xp, st.health, st.wielded, st.worn, st.chillUntil ? new Date(st.chillUntil) : null],
    );
  }

  /** The player has left for good: drop their fights and forget them until next time. */
  async forget(id: number): Promise<void> {
    await this.save(id);
    this.endFightsWith(`p:${id}`);
    this.players.delete(id);
  }

  isNew(st: PlayerState, now = Date.now()): boolean {
    return now - st.createdAt < NEW_PLAYER_MS;
  }

  /** Fighting someone, or someone is fighting you: dropping the connection won't save you. */
  inCombat(id: number): boolean {
    const st = this.players.get(id);
    if (!st) return false;
    return !!st.target || this.isTargeted(`p:${id}`);
  }

  private isTargeted(key: string): boolean {
    for (const p of this.players.values()) if (p.target === key) return true;
    for (const m of this.mobs.values()) if (m.target === key) return true;
    return false;
  }

  state(id: number): PlayerState | undefined {
    return this.players.get(id);
  }

  extraLoad(id: number): number {
    return this.players.get(id)?.carrying ? CORPSE_WEIGHT : 0;
  }

  // ---------------------------------------------------------------- gear

  private async gear(st: PlayerState): Promise<{ weapon: ItemTemplate | null; armour: ItemTemplate | null }> {
    const mine = await itemsOf(this.game.catalog, { type: 'player', id: st.id });
    const w = st.wielded ? mine.find((i) => i.id === st.wielded) : undefined;
    const a = st.worn ? mine.find((i) => i.id === st.worn) : undefined;
    // Sold, dropped or given away since: back to bare hands.
    if (st.wielded && !w) {
      st.wielded = null;
      st.dirty = true;
    }
    if (st.worn && !a) {
      st.worn = null;
      st.dirty = true;
    }
    return { weapon: w?.template ?? null, armour: a?.template ?? null };
  }

  async wield(s: Session, rest: string): Promise<void> {
    const st = await this.load(s.player!);
    const { findItem } = await import('./commerce.js');
    const item = findItem(await this.game.commerce.myItems(s), rest);
    if (!rest) return s.out('Wield what?');
    if (!item) return s.out("You aren't carrying that.");
    if (!item.template.damage) return s.out(`${capitalize(item.template.name)} is no weapon.`);
    st.wielded = item.id;
    st.dirty = true;
    s.out(`You wield ${item.template.name}.`);
    this.game.toRoom(s.player!.roomId, `${c.player(s.player!.name)} wields ${item.template.name}.`, s);
  }

  async wear(s: Session, rest: string): Promise<void> {
    const st = await this.load(s.player!);
    const { findItem } = await import('./commerce.js');
    if (!rest) return s.out('Wear what?');
    const item = findItem(await this.game.commerce.myItems(s), rest);
    if (!item) return s.out("You aren't carrying that.");
    if (!item.template.armour) return s.out(`You can't wear ${item.template.name}.`);
    st.worn = item.id;
    st.dirty = true;
    s.out(`You put on ${item.template.name}.`);
    this.game.toRoom(s.player!.roomId, `${c.player(s.player!.name)} puts on ${item.template.name}.`, s);
  }

  async remove(s: Session, rest: string): Promise<void> {
    const st = await this.load(s.player!);
    const { weapon, armour } = await this.gear(st);
    const t = cleanTarget(rest);
    const wantWeapon = !t || (weapon && (weapon.keywords.includes(t) || /weapon|blade/.test(t)));
    const wantArmour = !t || (armour && (armour.keywords.includes(t) || /armou?r/.test(t)));
    if (!weapon && !armour) return s.out("You aren't wielding or wearing anything.");
    if (wantWeapon && weapon) {
      st.wielded = null;
      s.out(`You put away ${weapon.name}.`);
    }
    if (wantArmour && armour) {
      st.worn = null;
      s.out(`You take off ${armour.name}.`);
    }
    st.dirty = true;
  }

  /** Lines for the inventory: what's in your hands, on your back, and over your shoulder. */
  async gearLines(s: Session): Promise<string[]> {
    const st = await this.load(s.player!);
    const { weapon, armour } = await this.gear(st);
    const lines: string[] = [];
    if (weapon) lines.push(`Wielding: ${c.thing(weapon.name)}`);
    if (armour) lines.push(`Wearing: ${c.thing(armour.name)}`);
    if (st.carrying) {
      const { rows } = await query('SELECT name FROM corpses WHERE id=$1', [st.carrying]);
      if (rows[0]) lines.push(`Over your shoulder: ${c.thing(`the corpse of ${rows[0].name}`)}`);
      else st.carrying = null;
    }
    return lines;
  }

  /** Food and drink with an effect: stew heals, ale emboldens. */
  onConsume(s: Session, t: ItemTemplate): void {
    const st = this.players.get(s.player!.id);
    if (!st) return;
    if (t.heals) {
      const before = st.health;
      st.health = Math.min(maxHealthFor(st.level), st.health + t.heals);
      st.dirty = true;
      if (st.health > before) s.out(c.dim(`You feel better. (${st.health}/${maxHealthFor(st.level)})`));
      this.game.updateStatus(s);
    }
    if (t.id === 'ale') {
      st.aleUntil = Date.now() + ALE_MS;
      s.out(c.dim('Dutch courage: you hit a little harder, and a little less often, for a while.'));
    }
  }

  async bandage(s: Session): Promise<void> {
    const st = await this.load(s.player!);
    if (st.target || this.isTargeted(`p:${st.id}`)) return s.out("No time for that, you're in a fight!");
    const max = maxHealthFor(st.level);
    if (st.health >= max) return s.out("You've nothing that needs binding.");
    const mine = await this.game.commerce.myItems(s);
    const roll = mine.find((i) => i.template.id === 'bandage');
    if (!roll) return s.out('You have no bandages. Father Osmund sells them in the nave.');
    const ok = await tx((cl) => deleteItem(cl, roll.id, { type: 'player', id: st.id }));
    if (!ok) return;
    st.health = Math.min(max, st.health + (roll.template.heals ?? 5));
    st.dirty = true;
    s.out(`You bind your wounds tight. It stings, then it's better. (${st.health}/${max})`);
    this.game.toRoom(s.player!.roomId, `${c.player(s.player!.name)} binds a wound.`, s);
    this.game.updateStatus(s);
  }

  // ---------------------------------------------------------------- fighting

  private sanctuary(roomId: string): boolean {
    return this.game.world.room(roomId).flags.includes('sanctuary');
  }

  private async fighterFor(key: string): Promise<Fighter | null> {
    if (key.startsWith('p:')) {
      const id = Number(key.slice(2));
      const st = this.players.get(id);
      const roomId = this.game.playerRoom(id);
      if (!st || !roomId) return null;
      const { weapon, armour } = await this.gear(st);
      const now = Date.now();
      return {
        key,
        name: st.name,
        roomId,
        level: st.level,
        health: st.health,
        maxHealth: maxHealthFor(st.level),
        damage: weapon?.damage ?? [1, 2],
        armour: armour?.armour ?? 0,
        hit2: weaponVerb(weapon)[0],
        hit3: weaponVerb(weapon)[1],
        aim: (st.chillUntil > now ? -15 : 0) + (st.aleUntil > now ? -5 : 0),
        extra: st.aleUntil > now ? 1 : 0,
      };
    }
    const m = this.mobs.get(key.slice(2));
    if (!m) return null;
    const spec = MOBS[m.kind];
    return {
      key,
      name: this.mobName(m),
      roomId: m.npc.roomId,
      level: m.level,
      health: m.health,
      maxHealth: m.maxHealth,
      damage: spec.damage,
      armour: spec.armour,
      hit2: spec.hits,
      hit3: spec.hits,
      aim: 0,
      extra: 0,
    };
  }

  /** "Wat Ditchwater" for people, "the stray dog" for beasts. */
  mobName(m: Mob): string {
    if (MOBS[m.kind].named) return m.npc.card.listName!.split(',')[0];
    return m.npc.card.listName!.replace(/^(a|an) /, 'the ');
  }

  /** attack <someone>. Players and street folk are fair game outside sanctuaries; the townsfolk are not. */
  async attack(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const st = await this.load(p);
    const t = cleanTarget(rest);
    if (!t) return s.out('Attack whom?');
    const roomId = p.roomId;
    const npc = this.findMob(roomId, t) ?? this.game.world.findNpc(roomId, t);
    const other = npc ? undefined : this.game.playersIn(roomId, s).find((o) => o.player!.name.toLowerCase().startsWith(t.split(' ')[0]));
    if (!npc && !other) return s.out("There's nobody like that here.");
    if (npc && !npc.mob) {
      s.out(`You size up ${npc.name} and think better of it. The whole town would hang you for it.`);
      return this.game.toRoom(roomId, c.dim(`${p.name} eyes ${npc.name} with murder in mind, then thinks better of it.`), s);
    }
    if (this.sanctuary(roomId)) {
      const who = this.game.world.npcsIn(roomId).find((n) => n.id === 'osmund');
      return s.out(who ? "Father Osmund's glare stops your hand. Not here. Not in this house." : 'Something in this place stays your hand. Not here.');
    }
    const key = npc ? `m:${npc.id}` : `p:${other!.player!.id}`;
    if (key === `p:${p.id}`) return s.out('You think about it. Not today.');
    if (other) {
      const ost = await this.load(other.player!);
      if (this.isNew(st)) return s.out('You are too new to these streets to pick fights with other people. Give it a couple of hours.');
      if (this.isNew(ost)) return s.out(`${other.player!.name} is too new to these streets. Leave them be.`);
    }
    if (st.target === key) return s.out("You're already fighting them!");
    // Morda wants no blood on her floor.
    if (this.game.world.npcsIn(roomId).some((n) => n.id === 'morda')) return this.thrownOut(s, key);
    const victim = await this.fighterFor(key);
    if (!victim) return s.out("There's nobody like that here.");
    st.target = key;
    st.lastFight = Date.now();
    s.out(c.error(`You attack ${victim.name}!`));
    if (other) other.out(c.error(`${p.name} attacks you!`));
    this.game.toRoom(roomId, c.error(`${p.name} attacks ${victim.name}!`), s, other);
    if (npc) {
      const m = this.mobs.get(npc.id)!;
      if (!m.target) m.target = `p:${p.id}`;
      m.passedOut = 0;
      // One line of talk as the fight starts; the fight itself never waits for it.
      if (!MOBS[m.kind].mute) void this.game.npcRespond(s, npc, 'attacks you', 'event').catch(() => undefined);
    } else {
      const ost = this.players.get(other!.player!.id)!;
      if (!ost.target) ost.target = `p:${p.id}`;
      ost.lastFight = Date.now();
    }
    await this.round(`p:${p.id}`);
  }

  private async thrownOut(s: Session, victimKey: string): Promise<void> {
    const p = s.player!;
    const out = 'market_west';
    s.out(c.npc('Morda is round the bar before you can swing. She takes you by the collar and the belt and throws you out into the street. "Not on my floor."'));
    this.game.toRoom(p.roomId, c.npc(`Morda throws ${p.name} out into the street. "Not on my floor."`), s);
    await this.game.placePlayer(s, out, `${c.player(p.name)} comes flying out of the Drowned Rat and lands in the mud.`);
    if (victimKey.startsWith('m:')) {
      const m = this.mobs.get(victimKey.slice(2));
      if (m) this.moveMob(m, out, 'is thrown out after them');
    } else {
      const o = this.game.sessionOf(Number(victimKey.slice(2)));
      if (o) {
        o.out(c.npc('Morda throws you out too, for good measure.'));
        await this.game.placePlayer(o, out, `${c.player(o.player!.name)} is thrown out after them.`);
      }
    }
  }

  /** consider <someone>: how a fight would likely go. */
  async consider(s: Session, rest: string): Promise<void> {
    const st = await this.load(s.player!);
    const t = cleanTarget(rest);
    if (!t) return s.out('Consider whom?');
    const roomId = s.player!.roomId;
    const npc = this.findMob(roomId, t) ?? this.game.world.findNpc(roomId, t);
    let level: number | null = null;
    let name = '';
    let hurt = '';
    if (npc?.mob) {
      const m = this.mobs.get(npc.id)!;
      level = m.level;
      name = this.mobName(m);
      hurt = woundWords(m.health, m.maxHealth);
    } else if (npc) {
      return s.out(`${npc.name} is not someone you fight. Not if you want to keep living here.`);
    } else {
      const other = this.game.playersIn(roomId, s).find((o) => o.player!.name.toLowerCase().startsWith(t.split(' ')[0]));
      if (!other) return s.out("There's nobody like that here.");
      const ost = await this.load(other.player!);
      level = ost.level;
      name = ost.name;
      hurt = woundWords(ost.health, maxHealthFor(ost.level));
    }
    const d = level - st.level;
    const verdict =
      d <= -3 ? 'would barely be worth the effort' : d <= -1 ? 'should be an easy fight' : d === 0 ? 'looks like a fair match' : d === 1 ? 'would be a hard fight' : d === 2 ? 'would probably kill you' : 'would kill you without breaking a sweat';
    s.out(`${capitalize(name)} ${verdict}. Right now they are ${hurt}.`);
  }

  async flee(s: Session): Promise<void> {
    const st = await this.load(s.player!);
    if (!st.target && !this.isTargeted(`p:${st.id}`)) return s.out("You're not fighting anyone.");
    const room = this.game.world.room(s.player!.roomId);
    const ways = room.exits.filter((e) => !e.hidden && !room.locks[e.direction]);
    if (!ways.length || this.r() < 0.35) {
      s.out(c.error('You try to run, but there is no way through!'));
      this.game.toRoom(room.id, `${c.player(st.name)} tries to run and fails.`, s);
      return;
    }
    const way = ways[Math.floor(this.r() * ways.length)];
    st.target = null;
    s.out(c.system(`You flee ${way.direction}!`));
    this.game.toRoom(room.id, `${c.player(st.name)} flees ${way.direction}!`, s);
    await this.game.placePlayer(s, way.to, `${c.player(st.name)} arrives at a run.`);
  }

  private findMob(roomId: string, t: string): Npc | undefined {
    const here = [...this.mobs.values()].filter((m) => m.npc.roomId === roomId).map((m) => m.npc);
    if (!here.length || !t) return undefined;
    const exact = here.find((n) => n.card.keywords.some((k) => k === t) || n.name.toLowerCase() === t || (n.card.listName ?? '').toLowerCase().startsWith(t));
    if (exact) return exact;
    const hit = looseMatch(t, here.map((n) => ({ name: n.card.listName ?? n.name, keywords: n.card.keywords, ref: n })));
    return hit && 'ref' in hit ? hit.ref : undefined;
  }

  /** One round of every fight in town. */
  async tick(): Promise<void> {
    const keys = [
      ...[...this.players.values()].filter((p) => p.target).map((p) => `p:${p.id}`),
      ...[...this.mobs.values()].filter((m) => m.target).map((m) => `m:${m.id}`),
    ];
    for (const k of keys) await this.round(k);
    const now = Date.now();
    if (now - this.lastRegen >= 60_000) {
      this.lastRegen = now;
      this.regen();
    }
    for (const st of this.players.values()) if (st.dirty) await this.save(st.id);
  }

  /** The attacker's swing this round, if they still have someone to swing at. */
  private async round(key: string | null): Promise<void> {
    if (!key) return;
    const a = await this.fighterFor(key);
    if (!a) return;
    const targetKey = key.startsWith('p:') ? this.players.get(Number(key.slice(2)))?.target : this.mobs.get(key.slice(2))?.target;
    if (!targetKey) return;
    const d = await this.fighterFor(targetKey);
    if (!d || d.roomId !== a.roomId || d.health <= 0 || this.sanctuary(a.roomId)) {
      this.setTarget(key, null);
      return;
    }
    // The one being hit fights back.
    if (!this.getTarget(targetKey)) this.setTarget(targetKey, key);
    this.touch(key);
    this.touch(targetKey);

    const chance = Math.max(15, Math.min(95, 65 + 5 * (a.level - d.level) + a.aim));
    const aS = key.startsWith('p:') ? this.game.sessionOf(Number(key.slice(2))) : undefined;
    const dS = targetKey.startsWith('p:') ? this.game.sessionOf(Number(targetKey.slice(2))) : undefined;
    if (this.r() * 100 >= chance) {
      aS?.out(`You swing at ${d.name} and miss.`);
      dS?.out(`${capitalize(a.name)} swings at you and misses.`);
      this.game.toRoom(a.roomId, c.dim(`${capitalize(a.name)} swings at ${d.name} and misses.`), aS, dS);
      return;
    }
    const dmg = Math.max(1, randBetween(a.damage, this.r) + a.extra - d.armour);
    const left = Math.max(0, d.health - dmg);
    this.setHealth(targetKey, left);
    const how = left > 0 ? woundWords(left, d.maxHealth) : 'finished';
    aS?.out(`You ${a.hit2} ${d.name}. ${capitalize(d.name)} is ${how}.`);
    dS?.out(c.error(`${capitalize(a.name)} ${a.hit3} you for ${dmg}. You are ${left > 0 ? woundWords(left, d.maxHealth) : 'falling'}. (${left}/${d.maxHealth})`));
    this.game.toRoom(a.roomId, `${capitalize(a.name)} ${a.hit3} ${d.name}.`, aS, dS);
    if (dS) this.game.updateStatus(dS);
    if (left <= 0) return this.die(targetKey, key);
    // Street folk run when it goes badly.
    if (targetKey.startsWith('m:')) {
      const m = this.mobs.get(targetKey.slice(2));
      const spec = m && MOBS[m.kind];
      if (m && spec && spec.flee > 0 && m.health <= spec.flee * m.maxHealth && this.r() >= 0.5) this.mobFlee(m);
    }
  }

  private getTarget(key: string): string | null {
    return key.startsWith('p:') ? (this.players.get(Number(key.slice(2)))?.target ?? null) : (this.mobs.get(key.slice(2))?.target ?? null);
  }

  private setTarget(key: string, target: string | null): void {
    if (key.startsWith('p:')) {
      const st = this.players.get(Number(key.slice(2)));
      if (st) st.target = target;
    } else {
      const m = this.mobs.get(key.slice(2));
      if (m) m.target = target;
    }
  }

  private touch(key: string): void {
    if (key.startsWith('p:')) {
      const st = this.players.get(Number(key.slice(2)));
      if (st) st.lastFight = Date.now();
    }
  }

  private setHealth(key: string, health: number): void {
    if (key.startsWith('p:')) {
      const st = this.players.get(Number(key.slice(2)));
      if (st) {
        st.health = health;
        st.dirty = true;
      }
    } else {
      const m = this.mobs.get(key.slice(2));
      if (m) m.health = health;
    }
  }

  /** Stops everyone fighting this one, and this one fighting anyone. */
  endFightsWith(key: string): void {
    this.setTarget(key, null);
    for (const p of this.players.values()) if (p.target === key) p.target = null;
    for (const m of this.mobs.values()) if (m.target === key) m.target = null;
  }

  private regen(): void {
    for (const st of this.players.values()) {
      const max = maxHealthFor(st.level);
      if (st.target || st.health >= max || st.health <= 0) continue;
      const room = this.game.playerRoom(st.id);
      const rate = room === 'drowned_rat' || room === 'nave' || room === 'healers_ward' ? 3 : 1;
      st.health = Math.min(max, st.health + rate);
      st.dirty = true;
      const s = this.game.sessionOf(st.id);
      if (s) this.game.updateStatus(s);
    }
    for (const m of this.mobs.values()) if (!m.target && m.health < m.maxHealth) m.health = Math.min(m.maxHealth, m.health + 1);
  }

  // ---------------------------------------------------------------- death

  private async die(victimKey: string, killerKey: string | null): Promise<void> {
    this.endFightsWith(victimKey);
    const killer = killerKey?.startsWith('p:') ? this.players.get(Number(killerKey.slice(2))) : undefined;
    if (victimKey.startsWith('m:')) {
      const m = this.mobs.get(victimKey.slice(2));
      if (!m) return;
      await this.killMob(m, killer ?? null);
      return;
    }
    await this.killPlayer(Number(victimKey.slice(2)), killer ?? null, killerKey && killerKey.startsWith('m:') ? this.mobs.get(killerKey.slice(2)) : undefined);
  }

  /** A street person or beast dies: a corpse with what they had, experience for whoever did it. */
  async killMob(m: Mob, killer: PlayerState | null, how?: string): Promise<number> {
    const spec = MOBS[m.kind];
    const name = this.mobName(m);
    const roomId = m.npc.roomId;
    this.removeMob(m);
    this.game.toRoom(roomId, c.error(how ?? `${capitalize(name)} collapses and lies still.`));
    const corpseId = await this.makeCorpse(spec.corpse, null, name, roomId, m.coin, m.items, 0);
    await query('INSERT INTO kills (killer_id, victim_kind, victim_name, room_id) VALUES ($1,$2,$3,$4)', [killer?.id ?? null, m.kind, name, roomId]);
    if (killer) await this.gainXp(killer, m.level);
    if (m.home) this.respawnAt.set(`${m.home}:${m.kind}#${m.id}`, Date.now() + (m.kind === 'rat_king' ? RAT_KING_RESPAWN_MS : MOB_RESPAWN_MS));
    return corpseId;
  }

  private async gainXp(st: PlayerState, victimLevel: number): Promise<void> {
    const diff = victimLevel - st.level;
    const gain = Math.max(1, Math.round(8 * victimLevel * Math.max(0.25, 1 + diff * 0.25)));
    st.xp += gain;
    st.dirty = true;
    const s = this.game.sessionOf(st.id);
    s?.out(c.dim(`You gain ${gain} experience.`));
    while (st.level < MAX_LEVEL && st.xp >= xpForLevel(st.level + 1)) {
      st.level++;
      st.health = Math.min(maxHealthFor(st.level), st.health + 5);
      s?.out(c.title(`You are now level ${st.level}. You feel harder to kill. (${maxHealthFor(st.level)} health)`));
    }
    if (s) this.game.updateStatus(s);
  }

  /**
   * A player dies. Their goods stay on the corpse unless they're new; they wake in the temple with a grave chill.
   * by: what killed them, for the kill record.
   */
  async killPlayer(id: number, killer: PlayerState | null, mob?: Mob, cause?: string): Promise<number | null> {
    const st = this.players.get(id);
    if (!st) return null;
    const s = this.game.sessionOf(id);
    const roomId = this.game.playerRoom(id) ?? TEMPLE;
    this.endFightsWith(`p:${id}`);
    if (st.carrying) await this.dropCarried(st, roomId);
    const protectedNew = this.isNew(st);
    this.game.toRoom(roomId, c.error(`${st.name} falls and does not get up.`), s);
    s?.out(c.error(cause ?? 'You fall. The street comes up to meet you, and then there is nothing.'));
    let corpseId: number | null = null;
    if (protectedNew) {
      corpseId = await this.makeCorpse('player', id, st.name, roomId, 0, [], OWNER_ONLY_MS);
    } else {
      corpseId = await tx(async (cl) => {
        const { rows } = await cl.query('SELECT coin FROM players WHERE id=$1 FOR UPDATE', [id]);
        const coin = rows[0]?.coin ?? 0;
        const corpse = await cl.query(
          `INSERT INTO corpses (kind, player_id, name, room_id, coin, open_at, expires_at)
           VALUES ('player', $1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, now() + ($6 || ' milliseconds')::interval) RETURNING id`,
          [id, st.name, roomId, coin, String(OWNER_ONLY_MS), String(CORPSE_MS)],
        );
        const cid = Number(corpse.rows[0].id);
        if (coin > 0) await moveCoin(cl, id, -coin, 0, `died, ${coin} left on corpse ${cid}`);
        await cl.query(`UPDATE items SET owner_type='corpse', owner_id=$2 WHERE owner_type='player' AND owner_id=$1`, [String(id), String(cid)]);
        return cid;
      });
    }
    await query('INSERT INTO kills (killer_id, victim_kind, victim_name, victim_id, room_id) VALUES ($1,$2,$3,$4,$5)', [
      killer?.id ?? null,
      'player',
      st.name,
      id,
      roomId,
    ]);
    if (killer) await this.gainXp(killer, st.level);
    st.health = Math.ceil(maxHealthFor(st.level) / 2);
    st.chillUntil = Date.now() + CHILL_MS;
    st.wielded = protectedNew ? st.wielded : null;
    st.worn = protectedNew ? st.worn : null;
    st.target = null;
    st.lastFight = 0; // the dead are out of the fight
    st.dirty = true;
    await this.save(id);
    void mob;
    if (s) {
      s.out('');
      s.out(c.dim('...'));
      s.out(c.system('You wake on the cold stone floor of the Temple of Ash, shivering with a grave chill.'));
      s.out(
        protectedNew
          ? c.dim('You still have your things: the town spares the newly arrived, this once.')
          : c.dim('Your coin and your pack are on your body where you fell. You have half an hour to get them back.'),
      );
      await this.game.placePlayer(s, TEMPLE, `${c.player(st.name)} gasps awake on the temple floor, grey with a grave chill.`);
    } else {
      this.game.setLinkdeadRoom(id, TEMPLE);
      await query('UPDATE players SET room_id=$2 WHERE id=$1', [id, TEMPLE]);
    }
    return corpseId;
  }

  private async makeCorpse(kind: 'player' | 'street' | 'rat', playerId: number | null, name: string, roomId: string, coin: number, items: string[], ownerMs: number): Promise<number> {
    return tx(async (cl) => {
      const { rows } = await cl.query(
        `INSERT INTO corpses (kind, player_id, name, room_id, coin, open_at, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' milliseconds')::interval, now() + ($7 || ' milliseconds')::interval) RETURNING id`,
        [kind, playerId, name, roomId, coin, String(ownerMs), String(CORPSE_MS)],
      );
      const id = Number(rows[0].id);
      for (const t of items) if (this.game.catalog.templates.has(t)) await createItem(cl, t, { type: 'corpse', id });
      return id;
    });
  }

  // ---------------------------------------------------------------- corpses

  async corpsesIn(roomId: string): Promise<Array<{ id: number; kind: string; name: string; playerId: number | null; openAt: number }>> {
    const { rows } = await query('SELECT id, kind, name, player_id, open_at FROM corpses WHERE room_id=$1 AND carried_by IS NULL ORDER BY id', [roomId]);
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, name: r.name, playerId: r.player_id, openAt: new Date(r.open_at).getTime() }));
  }

  /** Names for the room's "You see" line. */
  async corpseNames(roomId: string): Promise<string[]> {
    return (await this.corpsesIn(roomId)).map((k) => `the corpse of ${k.name}`);
  }

  private async findCorpse(roomId: string, typed: string) {
    const t = cleanTarget(typed).replace(/^(corpse|body)( of)?\s*/, '');
    const here = await this.corpsesIn(roomId);
    if (!here.length) return undefined;
    if (!t) return here[here.length - 1];
    return here.find((k) => k.name.toLowerCase().includes(t)) ?? (/^(corpse|body)$/.test(cleanTarget(typed)) ? here.at(-1) : undefined);
  }

  /** Is the typed word about a corpse here? Cheap check before the database. */
  mentionsCorpse(typed: string): boolean {
    return /\b(corpse|body|bodies|corpses)\b/i.test(typed);
  }

  async lookCorpse(s: Session, typed: string): Promise<boolean> {
    if (!this.mentionsCorpse(typed)) return false;
    const k = await this.findCorpse(s.player!.roomId, typed);
    if (!k) return false;
    const { rows } = await query('SELECT coin FROM corpses WHERE id=$1', [k.id]);
    const items = await itemsOf(this.game.catalog, { type: 'corpse', id: k.id });
    s.out(`The corpse of ${k.name}${k.kind === 'rat' ? ', already stiffening' : ', face down in the muck'}.`);
    const what = [...items.map((i) => i.template.name), ...(rows[0]?.coin ? [`${rows[0].coin} coin`] : [])];
    s.out(what.length ? `On the body: ${what.join(', ')}.` : 'Nothing worth taking on it.');
    const mineOnly = k.kind === 'player' && k.playerId !== s.player!.id && k.openAt > Date.now();
    s.out(c.dim(mineOnly ? `Only ${k.name} may touch it for a few minutes yet.` : 'loot corpse to take it all. take corpse to carry it.'));
    return true;
  }

  async loot(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    const k = await this.findCorpse(p.roomId, rest || 'corpse');
    if (!k) return s.out('There is no body here to loot.');
    if (k.kind === 'player' && k.playerId !== p.id && k.openAt > Date.now()) {
      return s.out(`Something stops your hand. ${k.name} might still come back for it. Wait a few minutes.`);
    }
    const items = await itemsOf(this.game.catalog, { type: 'corpse', id: k.id });
    const mine = await this.game.commerce.myItems(s);
    let load = mine.reduce((w, i) => w + i.template.weight, 0) + this.extraLoad(p.id);
    const got: string[] = [];
    let full = false;
    await tx(async (cl) => {
      for (const i of items) {
        if (load + i.template.weight > 20) {
          full = true;
          continue;
        }
        if (await moveItem(cl, i.id, { type: 'corpse', id: k.id }, { type: 'player', id: p.id })) {
          load += i.template.weight;
          got.push(i.template.name);
        }
      }
    });
    const taken = await this.takeCorpseCoin(p.id, k.id);
    if (taken) got.push(`${taken} coin`);
    if (!got.length) return s.out(full ? 'Your pack is too full to take anything.' : `There's nothing left on ${k.name}.`);
    s.out(`You go through the pockets of ${k.name} and take: ${got.join(', ')}.`);
    if (full) s.out('Your pack is full. Some things are left behind.');
    this.game.toRoom(p.roomId, `${c.player(p.name)} goes through the pockets of ${k.name}.`, s);
    this.game.updateStatus(s);
  }

  private async takeCorpseCoin(playerId: number, corpseId: number): Promise<number> {
    return tx(async (cl) => {
      const { rows } = await cl.query('SELECT coin FROM corpses WHERE id=$1 FOR UPDATE', [corpseId]);
      const coin = rows[0]?.coin ?? 0;
      if (coin <= 0) return 0;
      await cl.query('UPDATE corpses SET coin = 0 WHERE id=$1', [corpseId]);
      await moveCoin(cl, playerId, coin, 0, `looted corpse ${corpseId}`);
      return coin;
    });
  }

  /** take corpse: put a body over your shoulder. */
  async takeCorpse(s: Session, rest: string): Promise<boolean> {
    if (!this.mentionsCorpse(rest)) return false;
    const p = s.player!;
    const st = await this.load(p);
    const k = await this.findCorpse(p.roomId, rest);
    if (!k) return false;
    if (st.carrying) {
      s.out('You already have a body over your shoulder.');
      return true;
    }
    if (k.kind === 'rat') {
      s.out('Nobody pays for dead rats. Take the tail, leave the rest.');
      return true;
    }
    if (k.kind === 'player' && k.playerId !== p.id && k.openAt > Date.now()) {
      s.out(`Leave it a few minutes. ${k.name} might still come back for it.`);
      return true;
    }
    const mine = await this.game.commerce.myItems(s);
    if (mine.reduce((w, i) => w + i.template.weight, 0) + CORPSE_WEIGHT > 20) {
      s.out("You can't lift a body with your pack that full.");
      return true;
    }
    const { rowCount } = await query('UPDATE corpses SET carried_by=$2, room_id=NULL WHERE id=$1 AND carried_by IS NULL AND room_id=$3', [k.id, p.id, p.roomId]);
    if (rowCount !== 1) {
      s.out('Someone got to it first.');
      return true;
    }
    st.carrying = k.id;
    s.out(`You heave the corpse of ${k.name} over your shoulder. It's heavier than it looks.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} heaves the corpse of ${k.name} over one shoulder.`, s);
    return true;
  }

  private async dropCarried(st: PlayerState, roomId: string): Promise<string | null> {
    const id = st.carrying;
    st.carrying = null;
    if (!id) return null;
    const { rows } = await query('UPDATE corpses SET carried_by=NULL, room_id=$2 WHERE id=$1 RETURNING name', [id, roomId]);
    return rows[0]?.name ?? null;
  }

  /** drop corpse: put it down. In the ossuary, Osmund pays for the burial. */
  async dropCorpse(s: Session, rest: string): Promise<boolean> {
    if (!this.mentionsCorpse(rest)) return false;
    const p = s.player!;
    const st = await this.load(p);
    if (!st.carrying) {
      s.out("You aren't carrying a body.");
      return true;
    }
    if (p.roomId === 'ossuary') return this.bury(s, st), true;
    const name = await this.dropCarried(st, p.roomId);
    s.out(`You let the corpse of ${name} slide off your shoulder into the muck.`);
    this.game.toRoom(p.roomId, `${c.player(p.name)} drops the corpse of ${name}.`, s);
    return true;
  }

  /** give corpse to osmund, or drop it in the ossuary: a burial fee, and for a player, their things home. */
  async bury(s: Session, st?: PlayerState): Promise<void> {
    const p = s.player!;
    st ??= await this.load(p);
    if (!st.carrying) return s.out("You aren't carrying a body.");
    if (p.roomId !== 'nave' && p.roomId !== 'ossuary') return s.out('Father Osmund takes the dead in the nave, or you can lay them in the ossuary below it.');
    const corpseId = st.carrying;
    const { rows } = await query('SELECT kind, name, player_id, coin FROM corpses WHERE id=$1', [corpseId]);
    const k = rows[0];
    if (!k) {
      st.carrying = null;
      return s.out('The body is gone.');
    }
    const pay = k.kind === 'player' ? 2 : 3;
    await tx(async (cl) => {
      if (k.kind === 'player' && k.player_id) {
        // Their things go home to them.
        await cl.query(`UPDATE items SET owner_type='player', owner_id=$2 WHERE owner_type='corpse' AND owner_id=$1`, [String(corpseId), String(k.player_id)]);
        if (k.coin > 0) await moveCoin(cl, k.player_id, k.coin, 0, `corpse ${corpseId} brought home`);
      } else {
        await cl.query(`DELETE FROM items WHERE owner_type='corpse' AND owner_id=$1`, [String(corpseId)]);
      }
      await cl.query('DELETE FROM corpses WHERE id=$1', [corpseId]);
      await moveCoin(cl, p.id, pay, 0, `burial of ${k.name}`);
    });
    st.carrying = null;
    s.out(c.npc(`Father Osmund looks at the body for a long moment. "Another one." He presses ${pay} coin into your hand for the burial.`));
    if (k.kind === 'player') {
      s.out(c.dim(`${k.name}'s things will find their way back to them.`));
      const owner = k.player_id ? this.game.sessionOf(k.player_id) : undefined;
      owner?.out(c.system(`Someone has brought your body to the temple. Your things are back in your pack.`));
      if (owner) this.game.updateStatus(owner);
    }
    this.game.toRoom(p.roomId, `${c.player(p.name)} lays the corpse of ${k.name} down for burial.`, s);
    this.game.updateStatus(s);
  }

  /** sell corpse to butcher: better paid, no questions, and word sometimes gets around. */
  async sellToButcher(s: Session): Promise<void> {
    const p = s.player!;
    const st = await this.load(p);
    if (!st.carrying) return s.out("You aren't carrying a body.");
    if (!this.game.world.npcsIn(p.roomId).some((n) => n.id === 'butcher')) return s.out('The butcher works in Butcher\'s Alley.');
    const corpseId = st.carrying;
    const { rows } = await query('SELECT kind, name FROM corpses WHERE id=$1', [corpseId]);
    const k = rows[0];
    if (!k) {
      st.carrying = null;
      return s.out('The body is gone.');
    }
    if (k.kind === 'player') return s.out(c.npc('The butcher looks at the body, then at you. "Not that kind. Take it to the priest."'));
    await tx(async (cl) => {
      await cl.query(`DELETE FROM items WHERE owner_type='corpse' AND owner_id=$1`, [String(corpseId)]);
      await cl.query('DELETE FROM corpses WHERE id=$1', [corpseId]);
      await moveCoin(cl, p.id, 5, 0, `sold ${k.name} to the butcher`);
    });
    st.carrying = null;
    s.out(c.npc(`The butcher weighs the body with his eyes, nods once and counts five coin onto the block. He doesn't ask. You don't tell.`));
    this.game.toRoom(p.roomId, c.dim(`${p.name} does business with the butcher. Nobody watches.`), s);
    if (this.r() < 1 / 3) {
      await nudgeStanding('osmund', p.id, -1);
      s.out(c.dim('Word gets around. Father Osmund will hear of this.'));
    }
    this.game.updateStatus(s);
  }

  // ---------------------------------------------------------------- temple, watch

  async heal(s: Session): Promise<void> {
    const p = s.player!;
    if (!this.game.world.npcsIn(p.roomId).some((n) => n.id === 'osmund')) return s.out('Father Osmund heals in the nave, for a price.');
    const st = await this.load(p);
    const max = maxHealthFor(st.level);
    const missing = max - st.health;
    if (missing <= 0) return s.out(c.npc('"You\'re whole, my child. Go and spend it on candles."'));
    const fee = Math.max(1, Math.ceil(missing / 4));
    try {
      await tx((cl) => moveCoin(cl, p.id, -fee, 0, 'healing at the temple'));
    } catch {
      return s.out(c.npc(`"Healing costs ${fee} coin for wounds like those. The Lord is free. I am not."`));
    }
    st.health = max;
    st.dirty = true;
    s.out(c.npc(`Father Osmund mutters a prayer he doesn't believe and binds you with something that stings. You pay ${fee} coin and feel whole. (${max}/${max})`));
    this.game.toRoom(p.roomId, `Father Osmund tends to ${p.name}'s wounds.`, s);
    this.game.updateStatus(s);
  }

  /** recover: Osmund sends someone for your body, for a fee. */
  async recover(s: Session): Promise<void> {
    const p = s.player!;
    if (!this.game.world.npcsIn(p.roomId).some((n) => n.id === 'osmund')) return s.out('Father Osmund can send for your body. He is in the nave.');
    const { rows } = await query('SELECT id, coin FROM corpses WHERE player_id=$1 AND kind=$2 AND carried_by IS NULL ORDER BY died_at DESC LIMIT 1', [p.id, 'player']);
    if (!rows[0]) return s.out(c.npc('"Your body? You\'re standing in it. If you mean the other one, the cart has it, or nobody does."'));
    const fee = 5;
    const corpseId = Number(rows[0].id);
    try {
      await tx(async (cl) => {
        await moveCoin(cl, p.id, -fee, 0, 'body recovered by the temple');
        await cl.query(`UPDATE items SET owner_type='player', owner_id=$2 WHERE owner_type='corpse' AND owner_id=$1`, [String(corpseId), String(p.id)]);
        const { rows: k } = await cl.query('DELETE FROM corpses WHERE id=$1 RETURNING coin', [corpseId]);
        if (k[0]?.coin > 0) await moveCoin(cl, p.id, k[0].coin, 0, `coin back from corpse ${corpseId}`);
      });
    } catch {
      return s.out(c.npc(`"It's ${fee} coin to send the boy for a body. Come back when you have it. Bank it next time."`));
    }
    s.out(c.npc(`Father Osmund sends a boy running. Some time later he comes back pale and out of breath with your things in a sack. You pay ${fee} coin.`));
    this.game.updateStatus(s);
  }

  async bounty(s: Session): Promise<void> {
    const p = s.player!;
    if (p.roomId !== 'watch_house') return s.out('Bounties are paid at the watch house, north of the barracks yard.');
    const owed = await tx(async (cl) => {
      const { rows } = await cl.query(
        `UPDATE kills SET bounty_paid = TRUE WHERE killer_id=$1 AND victim_kind='cutpurse' AND bounty_paid = FALSE RETURNING id`,
        [p.id],
      );
      const pay = rows.length * 4;
      if (pay) await moveCoin(cl, p.id, pay, 0, `bounty on ${rows.length} cutpurse(s)`);
      return rows.length;
    });
    if (!owed) return s.out('The duty sergeant checks his ledger. "Nothing owed to you. Bring me cutpurses."');
    s.out(`The duty sergeant runs a thumb down his ledger, grunts, and counts out ${owed * 4} coin. "${owed} cutpurse${owed > 1 ? 's' : ''}. The town thanks you. Don't make a habit of enjoying it."`);
    this.game.updateStatus(s);
  }

  // ---------------------------------------------------------------- street life

  /** Every life tick: street folk move, brawl and arrive; beasts come back; dead bodies rot away. */
  async life(): Promise<void> {
    const now = Date.now();
    this.populate(now);
    for (const m of [...this.mobs.values()]) {
      if (m.target) continue;
      const spec = MOBS[m.kind];
      if (m.passedOut > now) continue;
      if (m.passedOut && m.passedOut <= now) {
        m.passedOut = 0;
        m.npc.card.listName = m.npc.card.listName!.replace(/, passed out in the road$/, '');
        this.game.toRoom(m.npc.roomId, `${capitalize(this.mobName(m))} wakes up, groans, and gets to their feet.`);
      }
      if (m.kind === 'drunk' && this.r() < 0.03) {
        m.passedOut = now + 5 * 60_000;
        m.npc.card.listName += ', passed out in the road';
        this.game.toRoom(m.npc.roomId, `${capitalize(this.mobName(m))} sits down very suddenly and passes out in the road.`);
        continue;
      }
      if (spec.street && now >= m.nextMove) {
        m.nextMove = now + 60_000 + Math.floor(this.r() * 120_000);
        const room = this.game.world.room(m.npc.roomId);
        const ways = room.exits.filter((e) => !e.hidden && this.game.world.room(e.to).flags.includes('street'));
        if (ways.length) {
          const way = ways[Math.floor(this.r() * ways.length)];
          this.moveMob(m, way.to, `${spec.moves} off ${way.direction}`, way.direction);
        }
      }
    }
    // Now and then, two street folk in the same room fall out.
    const byRoom = new Map<string, Mob[]>();
    for (const m of this.mobs.values()) {
      if (!MOBS[m.kind].street || m.target || m.passedOut) continue;
      byRoom.set(m.npc.roomId, [...(byRoom.get(m.npc.roomId) ?? []), m]);
    }
    for (const [, here] of byRoom) {
      const fighters = here.filter((m) => m.kind !== 'ragpicker' && m.kind !== 'preacher');
      if (fighters.length >= 2 && this.r() < 0.04) this.brawl(fighters[0], fighters[1]);
    }
    await this.rot();
  }

  brawl(a: Mob, b: Mob): void {
    a.target = `m:${b.id}`;
    b.target = `m:${a.id}`;
    this.game.toRoom(a.npc.roomId, c.error(`${capitalize(this.mobName(a))} shoves ${this.mobName(b)}, and suddenly it's a fight!`));
  }

  /** Keeps about the right number of street folk about, and puts beasts back where they live. */
  populate(now = Date.now()): void {
    const want = this.opts.streetFolk ?? 10;
    const street = [...this.mobs.values()].filter((m) => MOBS[m.kind].street).length;
    if (street < want) {
      // On a fresh start fill the streets at once; after that, one newcomer at a time.
      const n = this.mobs.size === 0 ? want - street : 1;
      for (let i = 0; i < n; i++) this.spawnStreet(this.mobs.size > 0 && i === 0);
    }
    if (this.opts.streetFolk === 0) return;
    for (const pop of SEWER_POP) {
      const have = [...this.mobs.values()].filter((m) => m.home === pop.room && m.kind === pop.kind).length;
      for (let i = have; i < pop.count; i++) {
        const waiting = [...this.respawnAt].find(([k]) => k.startsWith(`${pop.room}:${pop.kind}#`));
        if (waiting && waiting[1] > now) break;
        if (waiting) this.respawnAt.delete(waiting[0]);
        this.spawn(pop.kind, pop.room, pop.room);
      }
    }
  }

  private spawnStreet(announce: boolean): Mob {
    const total = STREET_MIX.reduce((n, [, w]) => n + w, 0);
    let roll = this.r() * total;
    let kind: MobKind = 'drunk';
    for (const [k, w] of STREET_MIX) {
      if ((roll -= w) < 0) {
        kind = k;
        break;
      }
    }
    const streets = [...this.game.world.rooms.values()].filter((r) => r.flags.includes('street')).map((r) => r.id);
    const arrive = announce ? (this.r() < 0.5 ? 'gate_road' : 'river_docks') : streets[Math.floor(this.r() * streets.length)];
    const m = this.spawn(kind, arrive, null);
    if (announce) this.game.toRoom(arrive, `${capitalize(m.npc.card.listName!)} ${arrive === 'gate_road' ? 'comes in through the gate' : 'climbs up from the docks'}.`);
    return m;
  }

  /** Makes one street person or beast and puts them in the world. */
  spawn(kind: MobKind, roomId: string, home: string | null): Mob {
    const spec = MOBS[kind];
    const g = generate(kind, this.r);
    const id = `m${this.nextId++}`;
    const npc: Npc = {
      id,
      roomId,
      name: g.name,
      kind: 'light',
      mob: true,
      card: {
        keywords: g.keywords,
        listName: g.listName,
        short: `${capitalize(g.listName)} is here.`,
        look: g.look,
        scripted: spec.card.scripted,
        ambient: spec.card.ambient,
        job: spec.card.job,
        personality: spec.card.personality,
        speech: spec.card.speech,
        wants: spec.card.wants,
        knows: spec.card.knows,
        quirks: g.quirk ?? undefined,
        mute: spec.mute,
        speaker: spec.named ? undefined : g.listName.replace(/^(a|an) /, 'the '),
      },
    };
    const m: Mob = {
      id,
      kind,
      npc,
      level: spec.level,
      health: g.health,
      maxHealth: g.health,
      coin: g.coin,
      items: g.items,
      target: null,
      nextMove: Date.now() + 60_000 + Math.floor(this.r() * 120_000),
      passedOut: 0,
      home,
    };
    this.mobs.set(id, m);
    this.game.world.npcs.set(id, npc);
    return m;
  }

  private removeMob(m: Mob): void {
    this.endFightsWith(`m:${m.id}`);
    this.mobs.delete(m.id);
    this.game.world.npcs.delete(m.id);
  }

  moveMob(m: Mob, to: string, how: string, dir?: Direction): void {
    const from = m.npc.roomId;
    const name = capitalize(this.mobName(m));
    this.game.toRoom(from, `${name} ${how}.`);
    m.npc.roomId = to;
    const back = dir ? OPPOSITE[dir] : null;
    const fromText = !back ? '' : back === 'up' ? ' from above' : back === 'down' ? ' from below' : ` from the ${back}`;
    this.game.toRoom(to, `${name} ${MOBS[m.kind].moves} in${fromText}.`);
  }

  private mobFlee(m: Mob): void {
    const room = this.game.world.room(m.npc.roomId);
    const ways = room.exits.filter((e) => !e.hidden && !room.locks[e.direction] && (!MOBS[m.kind].street || this.game.world.room(e.to).flags.includes('street')));
    if (!ways.length) return;
    const way = ways[Math.floor(this.r() * ways.length)];
    this.endFightsWith(`m:${m.id}`);
    this.moveMob(m, way.to, `breaks away and flees ${way.direction}`, way.direction as Direction);
  }

  /** Bodies nobody came for rot away after half an hour. */
  async rot(): Promise<void> {
    const { rows } = await query(`DELETE FROM corpses WHERE expires_at < now() AND carried_by IS NULL RETURNING id, room_id, name`);
    for (const r of rows) {
      await query(`DELETE FROM items WHERE owner_type='corpse' AND owner_id=$1`, [String(r.id)]);
      if (r.room_id) this.game.toRoom(r.room_id, c.dim(`Someone drags away the corpse of ${r.name}.`));
    }
  }

  /** All the street folk and beasts in a room. */
  mobsIn(roomId: string): Mob[] {
    return [...this.mobs.values()].filter((m) => m.npc.roomId === roomId);
  }
}

export { DIRECTIONS };
export type { Item };
