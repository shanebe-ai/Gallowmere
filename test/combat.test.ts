import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { pool, query } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { stripAnsi } from '../src/game/text.js';
import { ROUTE } from '../src/game/cart.js';
import { MOBS } from '../src/game/mobs.js';
import { maxHealthFor, woundWords, xpForLevel } from '../src/game/combat.js';
import { JOURNAL } from '../src/game/game.js';
import { FakeProvider, reply } from './fakes.js';

let url = '';
let app: Awaited<ReturnType<typeof createApp>>;
const groq = new FakeProvider('groq', () => reply('Come on then!'), 2000);
const sockets: Socket[] = [];
/** The game's dice. Tests load them to make a fight go one way. */
let dice: () => number = Math.random;

class Player {
  socket: Socket;
  buf = '';
  constructor(cols = 200) {
    this.socket = ioClient(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(this.socket);
    this.socket.on('out', (t: string) => (this.buf += stripAnsi(t)));
    this.socket.on('connect', () => this.socket.emit('hello', { token: null, cols }));
  }
  async waitFor(re: RegExp, timeout = 4000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const m = this.buf.match(re);
      if (m) {
        const end = (m.index ?? 0) + m[0].length;
        const seen = this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        return seen;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timed out waiting for ${re}. Buffer:\n${this.buf}`);
  }
  async do(line: string, re: RegExp) {
    await new Promise((r) => setTimeout(r, 110));
    this.socket.emit('line', line);
    return this.waitFor(re);
  }
  async close() {
    if (this.socket.connected) {
      this.socket.emit('line', 'quit');
      await new Promise((r) => this.socket.once('disconnect', r));
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function login(name: string, room?: string) {
  if (room) await query('UPDATE players SET room_id=$2 WHERE lower(name)=lower($1)', [name, room]);
  const p = new Player();
  await p.waitFor(/By what name/);
  await p.do(name, /Welcome back/);
  await p.do('secret1', /Exits:/);
  return p;
}

/** A character; old ones are past the two hour newcomer protection. */
async function create(name: string, room: string, opts: { old?: boolean; coin?: number; level?: number } = {}) {
  const p = new Player();
  await p.waitFor(/By what name/);
  await p.do(name, /Make a new character/);
  await p.do('y', /Choose a password/);
  await p.do('secret1', /Once more/);
  await p.do('secret1', /Exits:/);
  await p.close();
  if (opts.old) await query("UPDATE players SET created_at = now() - interval '3 hours' WHERE name=$1", [name]);
  if (opts.coin !== undefined) await query('UPDATE players SET coin=$2 WHERE name=$1', [name, opts.coin]);
  if (opts.level) await query('UPDATE players SET level=$2, health=$3 WHERE name=$1', [name, opts.level, maxHealthFor(opts.level)]);
  return login(name, room);
}

const idOf = async (name: string) => (await query('SELECT id FROM players WHERE name=$1', [name])).rows[0].id as number;
const coinOf = async (name: string) => (await query('SELECT coin, bank_coin FROM players WHERE name=$1', [name])).rows[0];
const give = async (name: string, template: string) =>
  query(`INSERT INTO items (template_id, owner_type, owner_id) SELECT $2, 'player', id::text FROM players WHERE name=$1`, [name, template]);
const carried = async (name: string) =>
  (await query(`SELECT i.template_id FROM items i JOIN players p ON i.owner_type='player' AND i.owner_id=p.id::text WHERE p.name=$1 ORDER BY 1`, [name])).rows.map((r) => r.template_id);

/** Runs fight rounds until the condition holds. */
async function fightUntil(done: () => boolean | Promise<boolean>, rounds = 80): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (await done()) return;
    await app.game.combat.tick();
  }
  throw new Error('the fight never ended');
}

function clearMobs() {
  for (const m of [...app.game.combat.mobs.values()]) {
    app.game.combat.mobs.delete(m.id);
    app.game.world.npcs.delete(m.id);
  }
}

beforeAll(async () => {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = await createApp({
    providers: [{ provider: groq, rpm: 1000 }],
    telnetPort: null,
    game: {
      random: () => dice(),
      // Timers stay off: tests drive rounds, street life and the cart by hand.
      combat: { streetFolk: 0, tickMs: 1e9, lifeMs: 1e9 },
      cart: { warnMs: 1e9, stepMs: 1e9, minMs: 1e9, maxMs: 2e9 },
      travelStepMs: 150,
    },
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  // The first character is the admin; make one so test characters aren't.
  await create('Boss', 'north_gate').then((p) => p.close());
});

beforeEach(() => {
  dice = Math.random;
  clearMobs();
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  app.game.stop();
  app.io.close();
  await new Promise((r) => app.server.close(r));
  await pool.end();
});

describe('combat rules', () => {
  it('levels, health and wounds follow the spec', () => {
    expect(maxHealthFor(1)).toBe(20);
    expect(maxHealthFor(10)).toBe(65);
    expect(xpForLevel(2)).toBe(25);
    expect(woundWords(20, 20)).toBe('unhurt');
    expect(woundWords(5, 20)).toBe('bleeding badly');
    for (const spec of Object.values(MOBS)) expect(spec.damage[0]).toBeLessThanOrEqual(spec.damage[1]);
  });
});

describe('Milestone 3 end to end', () => {
  it('buy a cudgel, wield it, beat a drunk, loot him and gain experience', async () => {
    const p = await create('Ada', 'smithy_row', { coin: 40 });
    await p.do('buy cudgel', /You buy an oak cudgel/);
    await p.do('wield cudgel', /You wield an oak cudgel/);
    await p.do('i', /Wielding: an oak cudgel/);
    await p.do('e', /Market West/);
    await p.do('e', /Market Square/);
    const drunk = app.game.combat.spawn('drunk', 'market_square', null);
    drunk.coin = 4;
    drunk.items = ['empty_bottle'];
    await p.do('look', /drunk/);
    await p.do('consider drunk', /fair match|easy fight/);
    dice = () => 0.01; // every swing lands
    await p.do(`attack ${drunk.npc.name}`, /You attack/);
    await fightUntil(() => !app.game.combat.mobs.has(drunk.id));
    await p.waitFor(/collapses and lies still/);
    await p.waitFor(/You gain \d+ experience/);
    const seen = await p.do('look', /Exits:/);
    expect(seen).toMatch(/the corpse of/);
    await p.do('look corpse', /On the body: an empty bottle, 4 coin/);
    const before = (await coinOf('Ada')).coin;
    await p.do('loot corpse', /take: an empty bottle, 4 coin/);
    expect((await coinOf('Ada')).coin).toBe(before + 4);
    await p.do('loot corpse', /nothing left/);
    const { rows } = await query("SELECT xp FROM players WHERE name='Ada'");
    expect(rows[0].xp).toBeGreaterThan(0);
    await p.close();
  });

  it('no fighting in sanctuaries or with the townsfolk; Morda throws fighters out', async () => {
    const p = await create('Bea', 'nave', { old: true });
    app.game.combat.spawn('drunk', 'nave', null);
    await p.do('attack drunk', /Father Osmund's glare stops your hand/);
    await p.do('attack osmund', /think better of it/);
    clearMobs();
    await query("UPDATE players SET room_id='drowned_rat' WHERE name='Bea'");
    await p.close();
    const q = await login('Bea', 'drowned_rat');
    const d = app.game.combat.spawn('bruiser', 'drowned_rat', null);
    await q.do('attack bruiser', /throws you out into the street[\s\S]*Market West/);
    expect(d.npc.roomId).toBe('market_west');
    await q.close();
  });

  it('players can fight players, but never newcomers', async () => {
    const a = await create('Cal', 'market_square', { old: true });
    const b = await create('Dot', 'market_square');
    await a.do('attack dot', /too new to these streets/);
    await b.do('attack cal', /You are too new/);
    await b.close();
    await query("UPDATE players SET created_at = now() - interval '3 hours' WHERE name='Dot'");
    const b2 = await login('Dot', 'market_square');
    await a.do('attack dot', /You attack Dot/);
    await b2.waitFor(/Cal attacks you/);
    dice = () => 0.99; // every swing misses
    await app.game.combat.tick();
    await b2.waitFor(/swings at you and misses/);
    await a.do('n', /You're in a fight! Flee/);
    dice = () => 0.9; // the flee works
    await a.do('flee', /You flee/);
    await a.close();
    await b2.close();
  });

  it('dying leaves your goods on your corpse; only you loot it at first; banked coin is safe', async () => {
    const v = await create('Eve', 'market_square', { old: true, coin: 12 });
    await query("UPDATE players SET bank_coin=30 WHERE name='Eve'");
    await give('Eve', 'knife');
    const other = await create('Fin', 'market_square', { old: true });
    const brute = app.game.combat.spawn('bruiser', 'market_square', null);
    dice = () => 0.01;
    brute.target = `p:${await idOf('Eve')}`;
    await fightUntil(async () => (await query("SELECT room_id FROM players WHERE name='Eve'")).rows[0].room_id === 'temple_of_ash');
    await v.waitFor(/You wake on the cold stone floor of the Temple of Ash/);
    await v.waitFor(/Temple of Ash/);
    expect((await coinOf('Eve')).coin).toBe(0);
    expect((await coinOf('Eve')).bank_coin).toBe(30);
    expect(await carried('Eve')).toEqual([]);
    await v.do('score', /grave chill/);
    // The body is where she fell, and only she may loot it for now.
    await other.do('look corpse', /On the body: a small knife, 12 coin/);
    await other.do('loot corpse', /Something stops your hand/);
    await other.do('take corpse', /Leave it a few minutes/);
    // She walks back and takes it all.
    await v.close();
    const v2 = await login('Eve', 'market_square');
    await v2.do('loot corpse', /take: a small knife, 12 coin/);
    expect((await coinOf('Eve')).coin).toBe(12);
    await v2.close();
    await other.close();
  });

  it('newcomers keep everything when they die', async () => {
    const p = await create('Gil', 'market_square', { coin: 9 });
    await give('Gil', 'rope');
    const brute = app.game.combat.spawn('bruiser', 'market_square', null);
    dice = () => 0.01;
    brute.target = `p:${await idOf('Gil')}`;
    await fightUntil(async () => (await query("SELECT room_id FROM players WHERE name='Gil'")).rows[0].room_id === 'temple_of_ash');
    await p.waitFor(/You still have your things/);
    expect((await coinOf('Gil')).coin).toBe(9);
    expect(await carried('Gil')).toEqual(['rope']);
    await p.close();
  });

  it('two players looting one body at the same time are paid once', async () => {
    const a = await create('Hal', 'market_east', { old: true });
    const b = await create('Ivy', 'market_east', { old: true });
    const m = app.game.combat.spawn('cutpurse', 'market_east', null);
    m.coin = 9;
    m.items = [];
    await app.game.combat.killMob(m, null);
    a.socket.emit('line', 'loot corpse');
    b.socket.emit('line', 'loot corpse');
    await new Promise((r) => setTimeout(r, 800));
    const total = (await coinOf('Hal')).coin + (await coinOf('Ivy')).coin;
    expect(total).toBe(10 + 10 + 9);
    await a.close();
    await b.close();
  });

  it('the plague cart: a toll of one in four, the badly hurt go on the cart, bodies and goods go to Hook', async () => {
    const rich = await create('Jem', 'market_west', { old: true, coin: 20 });
    const hurt = await create('Kay', 'market_west', { old: true, coin: 8 });
    await give('Kay', 'lamp');
    await query("UPDATE players SET health=3 WHERE name='Kay'");
    const kayId = await idOf('Kay');
    app.game.combat.state(kayId)!.health = 3;
    const fresh = await create('Lou', 'market_west', { coin: 20 });
    const indoors = await create('Max', 'curio_shop', { old: true, coin: 20 });
    const drunk = app.game.combat.spawn('drunk', 'market_west', null);
    drunk.passedOut = Date.now() + 60_000;
    expect(ROUTE).toContain('market_west');
    expect(ROUTE).not.toContain('curio_shop');
    app.game.cart.bell();
    await rich.waitFor(/The temple bell tolls/);
    await indoors.waitFor(/The temple bell tolls/);
    const hookBefore = (await query("SELECT count(*)::int AS n FROM items WHERE owner_type='shop' AND owner_id='hook' AND template_id='lamp'")).rows[0].n;
    await app.game.cart.work('market_west');
    await rich.waitFor(/comes out with 5 coin/);
    expect((await coinOf('Jem')).coin).toBe(15);
    await hurt.waitFor(/Hooks catch your arms/);
    await fresh.waitFor(/too fresh off the road/);
    expect((await coinOf('Lou')).coin).toBe(20);
    expect((await coinOf('Max')).coin).toBe(20);
    expect(app.game.combat.mobs.has(drunk.id)).toBe(false);
    expect((await query("SELECT count(*)::int AS n FROM corpses WHERE room_id='market_west'")).rows[0].n).toBe(0);
    const hookAfter = (await query("SELECT count(*)::int AS n FROM items WHERE owner_type='shop' AND owner_id='hook' AND template_id='lamp'")).rows[0].n;
    expect(hookAfter).toBe(hookBefore + 1);
    expect(app.game.cart.note()).toMatch(/bell has just tolled/);
    // The cart passes some rooms twice in a round, but takes the toll once.
    await app.game.cart.work('market_west');
    await rich.waitFor(/You have paid once tonight/);
    expect((await coinOf('Jem')).coin).toBe(15);
    for (const p of [rich, hurt, fresh, indoors]) await p.close();
    app.game.cart.out = false;
  });

  it('hauling bodies: Osmund pays 3, the butcher 5, and a player brought home gets their things back', async () => {
    const p = await create('Ned', 'market_square', { old: true, coin: 0 });
    const m = app.game.combat.spawn('drunk', 'market_square', null);
    m.items = [];
    m.coin = 0;
    await app.game.combat.killMob(m, null);
    await p.do('take corpse', /heave the corpse of .* over your shoulder/);
    await p.do('i', /Over your shoulder: the corpse of/);
    await p.close();
    const p2 = await login('Ned', 'nave');
    await p2.do('give corpse to osmund', /presses 3 coin into your hand/);
    expect((await coinOf('Ned')).coin).toBe(3);
    await p2.close();

    const p3 = await login('Ned', 'butchers_alley');
    const m2 = app.game.combat.spawn('ragpicker', 'butchers_alley', null);
    m2.items = [];
    await app.game.combat.killMob(m2, null);
    await p3.do('take corpse', /over your shoulder/);
    dice = () => 0.9; // word doesn't get around this time
    await p3.do('sell corpse to butcher', /counts five coin onto the block/);
    expect((await coinOf('Ned')).coin).toBe(8);
    await p3.close();

    // Ola dies with her things; Ned carries her home after the ten minutes.
    const o = await create('Ola', 'market_square', { old: true, coin: 6 });
    await give('Ola', 'rope');
    const brute = app.game.combat.spawn('bruiser', 'market_square', null);
    dice = () => 0.01;
    brute.target = `p:${await idOf('Ola')}`;
    await fightUntil(async () => (await query("SELECT room_id FROM players WHERE name='Ola'")).rows[0].room_id === 'temple_of_ash');
    clearMobs();
    await query("UPDATE corpses SET open_at = now() - interval '1 minute' WHERE name='Ola'");
    const n = await login('Ned', 'market_square');
    await n.do('take corpse of ola', /over your shoulder/);
    await n.close();
    const n2 = await login('Ned', 'nave');
    await n2.do('give corpse to osmund', /presses 2 coin/);
    await o.waitFor(/Your things are back in your pack/);
    expect(await carried('Ola')).toEqual(['rope']);
    expect((await coinOf('Ola')).coin).toBe(6);
    await n2.close();
    await o.close();
  });

  it('cutpurse bounties pay once at the watch house; Maud buys rat tails', async () => {
    const p = await create('Pip', 'market_square', { old: true, coin: 0 });
    const cp = app.game.combat.spawn('cutpurse', 'market_square', null);
    cp.items = [];
    dice = () => 0.01;
    await p.do('attack cutpurse', /You attack/);
    await fightUntil(() => !app.game.combat.mobs.has(cp.id));
    await p.close();
    const w = await login('Pip', 'watch_house');
    await w.do('bounty', /counts out 4 coin/);
    await w.do('bounty', /Nothing owed to you/);
    expect((await coinOf('Pip')).coin).toBe(4);
    await w.close();
    await give('Pip', 'rat_tail');
    const m = await login('Pip', 'maud_shop');
    await m.do('sell tail', /You sell a rat tail|Maud/);
    await m.close();
  });

  it('the iron door opens with a key, or for someone strong enough to force it', async () => {
    const p = await create('Quin', 'sealed_door', { old: true });
    await p.do('n', /chained and padlocked/);
    await give('Quin', 'iron_key');
    await p.do('n', /fit the iron key[\s\S]*The Old Cistern/);
    await p.do('s', /Before the Iron Door/);
    await p.close();
    const strong = await create('Rex', 'sealed_door', { old: true, level: 5 });
    await strong.do('n', /set your shoulder to the door[\s\S]*The Old Cistern/);
    await strong.close();
  });

  it('street folk fill the streets, never go indoors, and brawl with each other', async () => {
    const combat = app.game.combat as any;
    const before = combat.opts.streetFolk;
    combat.opts.streetFolk = 10;
    try {
      combat.populate();
      const street = [...app.game.combat.mobs.values()].filter((m) => MOBS[m.kind].street);
      expect(street).toHaveLength(10);
      for (const m of street) {
        expect(app.game.world.room(m.npc.roomId).flags).toContain('street');
        expect(m.npc.mob).toBe(true);
      }
      // Beasts are back in the sewers, and the rat king is in the Nest.
      expect([...app.game.combat.mobs.values()].some((m) => m.kind === 'rat_king' && m.npc.roomId === 'the_nest')).toBe(true);
      for (let i = 0; i < 20; i++) await combat.life();
      for (const m of app.game.combat.mobs.values()) {
        if (MOBS[m.kind].street) expect(app.game.world.room(m.npc.roomId).flags).toContain('street');
      }
      // A brawl runs to its end without anyone's help.
      clearMobs();
      const a = app.game.combat.spawn('bruiser', 'market_square', null);
      const b = app.game.combat.spawn('drunk', 'market_square', null);
      app.game.combat.brawl(a, b);
      dice = () => 0.01;
      await fightUntil(() => !app.game.combat.mobs.has(b.id) || b.npc.roomId !== 'market_square');
      // Named townsfolk are never street folk.
      for (const n of app.game.world.npcs.values()) if (['morda', 'tilly', 'hamo', 'osmund'].includes(n.id)) expect(n.mob).toBeFalsy();
    } finally {
      combat.opts.streetFolk = before;
      clearMobs();
    }
  });

  it('no one kind takes over the streets, however many die', async () => {
    const combat = app.game.combat as any;
    const before = combat.opts.streetFolk;
    combat.opts.streetFolk = 10;
    try {
      // Kill off everyone who brawls, again and again, and let the streets refill.
      for (let round = 0; round < 15; round++) {
        combat.populate();
        while ([...app.game.combat.mobs.values()].filter((m) => MOBS[m.kind].street).length < 10) combat.populate();
        for (const m of [...app.game.combat.mobs.values()]) if (!['preacher', 'ragpicker'].includes(m.kind) && MOBS[m.kind].street) await app.game.combat.killMob(m, null);
      }
      combat.populate();
      while ([...app.game.combat.mobs.values()].filter((m) => MOBS[m.kind].street).length < 10) combat.populate();
      const count = (k: string) => [...app.game.combat.mobs.values()].filter((m) => m.kind === k).length;
      expect(count('preacher')).toBeLessThanOrEqual(1);
      expect(count('ragpicker')).toBeLessThanOrEqual(1);
      expect(count('drunk') + count('cutpurse') + count('bruiser') + count('dog')).toBeGreaterThanOrEqual(6);
    } finally {
      combat.opts.streetFolk = before;
      clearMobs();
      await query('DELETE FROM corpses');
    }
  });

  it('health shows your wounds, weapon damage, armour and odds', async () => {
    const p = await create('Tam', 'market_square', { old: true });
    await give('Tam', 'shortsword');
    await give('Tam', 'leather_coat');
    await p.do('health', /You are unhurt\. Health 20\/20[\s\S]*Bare fists: 1 to 2 damage[\s\S]*No armour/);
    await p.do('wield sword', /You wield a short sword/);
    await p.do('wear coat', /You put on a leather coat/);
    await query("UPDATE players SET health=5 WHERE name='Tam'");
    app.game.combat.state(await idOf('Tam'))!.health = 5;
    await p.do('hp', /You are bleeding badly\. Health 5\/20[\s\S]*short sword: 3 to 6 damage[\s\S]*takes 2 off every hit[\s\S]*about 65%[\s\S]*cart men would take you for dead/);
    await p.do('look me', /Damp, mostly[\s\S]*Health 5\/20/);
    await p.close();
  });

  it('travel walks you to places you know, and stops when you type or get into a fight', async () => {
    const p = await create('Uri', 'north_gate', { old: true });
    await p.do('travel nave', /You don't know the way there yet/);
    for (const step of ['s', 'e', 'e', 'e']) await p.do(step, /Exits:/);
    await p.do('travel', /Places you know the way to:[\s\S]*The Nave/);
    await p.do('travel gate', /set off for The North Gate, 4 steps away/);
    await p.waitFor(/Temple Steps[\s\S]*Gate Road[\s\S]*The North Gate[\s\S]*Exits:/, 5000);
    expect((await query("SELECT room_id FROM players WHERE name='Uri'")).rows[0].room_id).toBe('north_gate');
    // Any command stops you on the way.
    await p.do('travel temple', /set off for The Nave/);
    await p.do('look', /You stop walking/);
    await new Promise((r) => setTimeout(r, 600));
    expect((await query("SELECT room_id FROM players WHERE name='Uri'")).rows[0].room_id).not.toBe('nave');
    // A fight stops you too.
    await p.close();
    const q = await login('Uri', 'gate_road');
    const b = app.game.combat.spawn('bruiser', 'temple_steps', null);
    b.target = `p:${await idOf('Uri')}`;
    await q.do('travel nave', /set off for The Nave/);
    // Arriving on the steps, the bruiser is waiting.
    await app.game.combat.tick();
    await q.waitFor(/You stop\.|You're in a fight/, 5000);
    expect((await query("SELECT room_id FROM players WHERE name='Uri'")).rows[0].room_id).toBe('temple_steps');
    await q.close();
  });

  it("a pilgrim's token takes you straight to the nave, but not out of a fight", async () => {
    const p = await create('Vin', 'river_docks', { old: true });
    await p.do('crush token', /don't have a pilgrim's token/);
    await give('Vin', 'pilgrim_token');
    await give('Vin', 'pilgrim_token');
    const d = app.game.combat.spawn('drunk', 'river_docks', null);
    d.target = `p:${await idOf('Vin')}`;
    await p.do('crush token', /not with someone at your throat/);
    clearMobs();
    await p.do('use token', /kneeling on the cold floor of the nave[\s\S]*The Nave/);
    expect(await carried('Vin')).toEqual(['pilgrim_token']);
    await p.do('travel docks', /set off for River Docks/);
    await p.do('stop', /You stop walking/);
    await p.close();
  });

  it('the journal lists only places you have found, and every travel word in it leads there', async () => {
    const p = await create('Wyn', 'north_gate', { old: true });
    await p.do('j', /Your notebook[\s\S]*Ways in and out[\s\S]*The North Gate \(Dace\): news and bribes[\s\S]*travel gate/);
    expect(p.buf).not.toMatch(/Hook/);
    await p.close();
    // Pretend Wyn has been everywhere, then follow every travel word in the notebook.
    const id = await idOf('Wyn');
    await query('INSERT INTO visited_rooms (player_id, room_id) SELECT $1, id FROM rooms ON CONFLICT DO NOTHING', [id]);
    const q = await login('Wyn', 'gate_road');
    const seen = await q.do('journal', /other place/);
    for (const e of JOURNAL) expect(seen).toContain(app.game.world.room(e.room).title);
    for (const e of JOURNAL) {
      await query("UPDATE players SET room_id='gate_road' WHERE name='Wyn'");
      const title = app.game.world.room(e.room).title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await q.do(`travel ${e.travel}`, new RegExp(`set off for ${title}|already there|${title}`));
      await q.do('stop', /You stop walking|standing still/);
    }
    await q.close();
  });

  it('the admin can only send the cart out from the bell tower', async () => {
    const admin = await login('Boss', 'market_square');
    await admin.do('cart', /The bell hangs in the bell tower, up the ladder from the nave/);
    expect(app.game.cart.out).toBe(false);
    await admin.close();
    const a2 = await login('Boss', 'bell_tower');
    await a2.do('ring bell', /haul on the rope[\s\S]*The temple bell tolls/);
    expect(app.game.cart.out).toBe(true);
    await a2.do('cart', /already out/);
    await a2.close();
    app.game.cart.out = false;
    // Anyone else ringing it just wakes the dogs.
    const p = await create('Xia', 'bell_tower', { old: true });
    await p.do('ring bell', /Every dog in Gallowmere starts barking/);
    expect(app.game.cart.out).toBe(false);
    await p.do('cart', /Huh\?|What\?|doesn't mean|fog swallows/);
    await p.close();
  });

  it('dropping the connection mid fight keeps you in it', async () => {
    const p = await create('Sal', 'market_square', { old: true });
    const d = app.game.combat.spawn('drunk', 'market_square', null);
    dice = () => 0.99;
    await p.do('attack drunk', /You attack/);
    const id = await idOf('Sal');
    p.socket.disconnect(); // no quit: the connection just drops
    await new Promise((r) => setTimeout(r, 300));
    expect(app.game.combat.inCombat(id)).toBe(true);
    expect(app.game.playerRoom(id)).toBe('market_square');
    expect(d.target).toBe(`p:${id}`);
  });
});
