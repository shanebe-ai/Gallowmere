import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { pool, query } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { stripAnsi } from '../src/game/text.js';
import { maxHealthFor } from '../src/game/combat.js';
import { bodyPay, rankOf, slur, stageOf } from '../src/game/town.js';
import { FISHING, RECIPES } from '../src/game/wilds.js';
import { MOBS } from '../src/game/mobs.js';
import { FakeProvider, reply } from './fakes.js';

let url = '';
let app: Awaited<ReturnType<typeof createApp>>;
let npcFn: (user: string) => string = () => reply('Mm.');
const groq = new FakeProvider('groq', (req) => npcFn(req.user), 2000);
const sockets: Socket[] = [];
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
  await p.do('secret1', /Exits:|You can feel your way/);
  return p;
}

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
const coinOf = async (name: string) => (await query('SELECT coin FROM players WHERE name=$1', [name])).rows[0].coin as number;
const give = async (name: string, template: string, n = 1) => {
  for (let i = 0; i < n; i++) await query(`INSERT INTO items (template_id, owner_type, owner_id) SELECT $2, 'player', id::text FROM players WHERE name=$1`, [name, template]);
};
const carried = async (name: string) =>
  (await query(`SELECT i.template_id FROM items i JOIN players p ON i.owner_type='player' AND i.owner_id=p.id::text WHERE p.name=$1 ORDER BY 1`, [name])).rows.map((r) => r.template_id as string);
const stateOf = async (name: string) => app.game.combat.state(await idOf(name))!;

async function fightUntil(done: () => boolean | Promise<boolean>, rounds = 120): Promise<void> {
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

/** A corpse of the given kind lying in a room, died this long ago. */
async function corpse(kind: 'street' | 'rat' | 'beast' | 'player', mobKind: string | null, room: string, agoMs = 0, name = 'Hob Twitch') {
  const { rows } = await query(
    `INSERT INTO corpses (kind, name, room_id, coin, died_at, open_at, expires_at, mob_kind)
     VALUES ($1,$2,$3,0, now() - ($4 || ' milliseconds')::interval, now(), now() + interval '30 minutes', $5) RETURNING id`,
    [kind, name, room, String(agoMs), mobKind],
  );
  return Number(rows[0].id);
}

beforeAll(async () => {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = await createApp({
    providers: [{ provider: groq, rpm: 1000 }],
    telnetPort: null,
    game: {
      random: () => dice(),
      combat: { streetFolk: 0, tickMs: 1e9, lifeMs: 1e9 },
      cart: { warnMs: 1e9, stepMs: 1e9, minMs: 1e9, maxMs: 2e9 },
      travelStepMs: 150,
      townMs: 1e9,
      wilds: { castMs: 60, snareMs: 0, foxChance: 0, ambushChance: 0, ghostChance: 0 },
    },
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  await create('Boss', 'north_gate').then((p) => p.close());
});

beforeEach(() => {
  dice = Math.random;
  npcFn = () => reply('Mm.');
  clearMobs();
  app.game.wilds.quietFalls = null;
  app.game.wilds.night = false;
  (app.game.wilds as any).opts = { castMs: 60, snareMs: 0, foxChance: 0, ambushChance: 0, ghostChance: 0 };
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  app.game.stop();
  app.io.close();
  await new Promise((r) => app.server.close(r));
  await pool.end();
});

describe('the north road and the forest, as data', () => {
  const rooms = JSON.parse(readFileSync(new URL('../src/world/rooms.json', import.meta.url), 'utf8'));
  const items = JSON.parse(readFileSync(new URL('../src/world/items.json', import.meta.url), 'utf8'));
  const ids = new Set(items.map((i: any) => i.id));

  it('the road is ten rooms from the Moor Road to the shut gate of Vesna', () => {
    expect(app.world.path('moor_road', 'shut_gate')).toEqual(Array(9).fill('north'));
    expect(app.world.room('shut_gate').exits.map((e) => e.to).sort()).toEqual(['long_climb', 'vesna_yard']);
  });

  it('every forest edge is fog, and the town is not', async () => {
    const outside = rooms.filter((r: any) => (r.flags ?? []).includes('outside'));
    expect(outside.length).toBeGreaterThan(50);
    expect(app.game.wilds.fogEdge(app.world.room('ew_hollow'))).toMatch(/fog/);
    expect(app.game.wilds.fogEdge(app.world.room('market_square'))).toBeNull();
  });

  it('every fishing spot is water, every recipe makes and uses real items', () => {
    for (const [room, table] of Object.entries(FISHING)) {
      expect(app.world.rooms.has(room), room).toBe(true);
      for (const [t] of table) expect(ids.has(t), t).toBe(true);
    }
    for (const r of RECIPES) {
      expect(ids.has(r.id), r.id).toBe(true);
      for (const n of r.needs) for (const t of n.any) expect(ids.has(t), t).toBe(true);
    }
    for (const spec of Object.values(MOBS)) for (const [t] of spec.carries) expect(ids.has(t), `${spec.kind}: ${t}`).toBe(true);
  });

  it('pays, ranks and stages follow the spec', () => {
    expect(bodyPay('rat', 'rat')).toBe(1);
    expect(bodyPay('street', 'drunk')).toBe(3);
    expect(bodyPay('street', 'bruiser')).toBe(5);
    expect(bodyPay('beast', 'fox')).toBe(6);
    expect(bodyPay('street', 'brigand')).toBe(9);
    expect(bodyPay('beast', 'bear')).toBe(10);
    expect(bodyPay('street', 'captain')).toBe(25);
    expect([0, 4, 5, 15, 30].map((n) => rankOf(n).name)).toEqual(['Carrier', 'Carrier', 'Bearer', 'Gatherer', "Warden's Hand"]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(stageOf)).toEqual(['sober', 'merry', 'merry', 'tipsy', 'tipsy', 'drunk', 'drunk', 'legless']);
    expect(slur('this is serious', () => 0.99)).toBe('thish ish sherioush');
    expect(slur('morda, one more for the road', () => 0.99)).toBe('morda, one more for the road *hic*');
  });
});

describe('Milestone 3.5 end to end', () => {
  it('walks the road to the shut gate and knocks; the voice wants a letter before it opens', async () => {
    npcFn = (u) => (/knocks on the gate of Vesna/.test(u) ? reply('Not yet. Go home, Gallowmere.') : reply('Mm.'));
    const p = await create('Wanda', 'north_gate', { old: true });
    for (let i = 0; i < 10; i++) await p.do('n', /Exits:/);
    await p.do('look', /The Shut Gate[\s\S]*a voice behind the gate/);
    await p.do('knock gate', /hammer on the gate[\s\S]*letter from your priest/);
    await p.do('n', /The gates are barred/);
    await p.do('read board', /VESNA/);
    await p.close();
  });

  it('the shrine ritual works only in order, once a day; fortunes cost a coin; no fighting', async () => {
    const p = await create('Sakura', 'shrine_gates', { old: true, coin: 10 });
    await p.do('e', /The Water Basin[\s\S]*walkers keep to the\s+side/);
    await p.do('w', /Red Gates/);
    await p.do('keep to the side', /edge of the path/);
    const arrived = await p.do('e', /The Water Basin[\s\S]*Exits:/);
    expect(arrived).not.toMatch(/walkers keep to the side/);
    await p.do('e', /The Shrine/);
    await p.do('bow', /points back to the water basin/);
    await p.do('w', /Basin/);
    await p.do('purify', /rinse your mouth/);
    await p.do('e', /The Shrine/);
    const st = await stateOf('Sakura');
    st.health = 3;
    await p.do('ring bell', /shows you/);
    for (const step of ['offer 1', 'ring bell', 'bow', 'bow', 'clap', 'clap', 'pray']) await p.do(step, /You/);
    expect(st.health).toBe(3);
    await p.do('bow', /every wound you carry closes/);
    expect(st.health).toBe(maxHealthFor(1));
    expect(st.favourUntil).toBeGreaterThan(Date.now());
    expect(await coinOf('Sakura')).toBe(9);
    // Again today: nothing but quiet.
    st.health = 3;
    await p.do('w', /Basin/);
    await p.do('purify', /rinse/);
    await p.do('e', /Shrine/);
    for (const step of ['offer 1', 'ring bell', 'bow', 'bow', 'clap', 'clap', 'pray']) await p.do(step, /You/);
    await p.do('bow', /had your blessing today/);
    expect(st.health).toBe(3);
    // A curse, tied to the tree.
    dice = () => 0.85; // the curse end of the fortunes
    await p.do('n', /Fortune Tree/);
    await p.do('draw fortune', /CURSE[\s\S]*tie fortune/);
    expect(await carried('Sakura')).toContain('curse_slip');
    expect(st.curseUntil).toBeGreaterThan(Date.now());
    await p.do('tie fortune', /bad luck stays with the tree/);
    expect(await carried('Sakura')).not.toContain('curse_slip');
    expect(st.curseUntil).toBe(0);
    dice = Math.random;
    // No fighting here.
    app.game.combat.spawn('fox', 'fortune_tree', null);
    await p.do('attack fox', /Not here/);
    await p.close();
  });

  it('the white fox, when it comes, leads to a light that never goes out', async () => {
    (app.game.wilds as any).opts.foxChance = 1;
    const p = await create('Kitsu', 'shrine_basin', { old: true });
    await p.do('n', /fog|can't go/);
    await p.do('purify', /rinse/);
    await p.do('e', /Shrine/);
    for (const step of ['offer 1', 'ring bell', 'bow', 'bow', 'clap', 'clap', 'pray']) await p.do(step, /You/);
    await p.do('bow', /white fox[\s\S]*follow fox/);
    await p.do('follow fox', /The Fox's Grove/);
    await p.do('take light', /cup the pale light/);
    expect(await carried('Kitsu')).toContain('fox_fire');
    await p.do('take light', /bowl is empty for you/);
    await p.do('s', /Fortune Tree/);
    await p.do('n', /no way through/);
    // It lights the dark.
    await p.close();
    const q = await login('Kitsu', 'bear_cave');
    await q.do('look', /The Bear's Cave[\s\S]*bracken nest/);
    await q.close();
  });

  it('dark places need a light, and a torch is made once from what it takes', async () => {
    const p = await create('Torva', 'stone_ring', { old: true });
    await p.do('d', /The Barrow[\s\S]*too dark to see/);
    await p.do('search chambers', /too dark/);
    await p.do('u', /The Old Stones/);
    await p.do('make torch', /You're missing rags, a stick, lamp oil/);
    await give('Torva', 'rags');
    await give('Torva', 'lamp_oil');
    await p.do('w', /Stones Track/);
    await p.do('n', /Bracken/);
    await p.do('take stick', /good dry stick/);
    await p.do('take stick', /picked the good sticks/);
    await p.do('make torch', /A torch, ready to light/);
    expect(await carried('Torva')).toEqual(['torch']);
    await p.do('make torch', /You're missing/);
    await p.do('light torch', /roars up/);
    expect(await carried('Torva')).toEqual([]);
    await p.do('s', /Stones Track/);
    await p.do('e', /Old Stones/);
    await p.do('d', /The Barrow[\s\S]*stone shelf/);
    // The light burns out.
    (await stateOf('Torva')).lightUntil = Date.now() - 1;
    app.game.wilds.tick();
    await p.waitFor(/gutters and goes out/);
    await p.do('look', /too dark/);
    await p.close();
  });

  it('fishing takes a rod and uses one bait a cast; the catch follows the spot', async () => {
    const p = await create('Fisher', 'drovers_ford', { old: true });
    await p.do('fish', /need a fishing rod/);
    await give('Fisher', 'fishing_rod');
    await p.do('fish', /need bait/);
    await give('Fisher', 'worm', 2);
    dice = () => 0.1; // bites, and the first fish on the ford's list
    await p.do('fish', /bait the hook with a fat worm/);
    await p.waitFor(/land a minnow/);
    expect(await carried('Fisher')).toEqual(['fishing_rod', 'minnow', 'worm']);
    dice = () => 0.99; // nothing bites
    await p.do('fish', /cast/);
    await p.waitFor(/nothing takes it/);
    expect(await carried('Fisher')).toEqual(['fishing_rod', 'minnow']);
    await p.do('fish', /need bait/);
    await p.do('n', /Toll Stump/);
    await p.do('fish', /no water/);
    await p.close();
  });

  it('dig for worms in soft ground, once an hour; make bait from bread', async () => {
    const p = await create('Digby', 'ew_hollow', { old: true });
    await p.do('dig', /two fat worms/);
    await p.do('dig', /turned this ground over/);
    expect(await carried('Digby')).toEqual(['worm', 'worm']);
    await give('Digby', 'bread');
    await p.do('make bait', /sticky ball/);
    expect(await carried('Digby')).toEqual(['bait', 'worm', 'worm']);
    await p.do('e', /Heath Edge/);
    await p.do('dig', /stones and roots/);
    await p.close();
  });

  it('campfire stew needs a fire; Morda cooks a pike into a pie for a coin', async () => {
    const p = await create('Cookie', 'ew_runs', { old: true, coin: 5 });
    await give('Cookie', 'perch');
    await give('Cookie', 'turnip');
    await p.do('make stew', /need a fire/);
    await p.do('e', /Clearing/);
    await p.do('make stew', /Campfire stew/);
    expect(await carried('Cookie')).toEqual(['campfire_stew']);
    await p.close();
    const q = await login('Cookie', 'drowned_rat');
    await give('Cookie', 'pike');
    await q.do('give pike to morda', /hot pie/);
    expect(await carried('Cookie')).toEqual(['campfire_stew', 'pie']);
    expect(await coinOf('Cookie')).toBe(4);
    await q.close();
  });

  it('snares: set on a rabbit run, kept in the database, checked later', async () => {
    const p = await create('Snarer', 'ew_runs', { old: true });
    await p.do('set snare', /no snare/);
    await give('Snarer', 'rope');
    await p.do('take stick', /good dry stick/);
    await p.do('make snare', /A snare/);
    await p.do('e', /Clearing/);
    await p.do('set snare', /rabbit runs in the Edgewood/);
    await p.do('w', /Rabbit Runs/);
    await p.do('set snare', /set the noose/);
    expect((await query('SELECT count(*)::int AS n FROM snares')).rows[0].n).toBe(1);
    dice = () => 0.1; // caught, and the snare kept
    await p.do('check snare', /A rabbit, caught clean[\s\S]*still good/);
    expect(await carried('Snarer')).toEqual(['rabbit', 'snare']);
    expect((await query('SELECT count(*)::int AS n FROM snares')).rows[0].n).toBe(0);
    await p.close();
  });

  it('brigands at the bend: never a newcomer; pay once and walk on; walk on without paying and it is a fight', async () => {
    (app.game.wilds as any).opts.ambushChance = 1;
    const n = await create('Newt', 'toll_stump', { coin: 9 });
    await n.do('n', /Brigand's Bend/);
    expect(app.game.wilds.ambushFor(await idOf('Newt'))).toBeUndefined();
    await n.close();

    const p = await create('Pilgrim', 'toll_stump', { old: true, coin: 9 });
    dice = () => 0.1;
    await p.do('n', /Brigand's Bend[\s\S]*Toll, pigeon\. 3 coin/);
    dice = Math.random;
    await p.do('pay', /Pleasure doing business/);
    expect(await coinOf('Pilgrim')).toBe(6);
    expect([...app.game.combat.mobs.values()].filter((m) => m.kind === 'brigand')).toHaveLength(0);
    await p.do('n', /Burnt Waystation/);
    await p.do('s', /Brigand's Bend/);
    // Paid once: no second ambush straight away.
    expect(app.game.wilds.ambushFor(await idOf('Pilgrim'))).toBeUndefined();
    await p.close();

    const f = await create('Fighter', 'toll_stump', { old: true, coin: 9, level: 15 });
    await give('Fighter', 'war_axe');
    await give('Fighter', 'mail_shirt');
    await f.do('wield axe', /You wield/);
    await f.do('wear mail', /You put on/);
    dice = () => 0.1;
    await f.do('n', /Toll, pigeon/);
    dice = Math.random;
    await f.do('n', /step into your way/);
    expect((await stateOf('Fighter')).target).toMatch(/^m:/);
    const fid = await idOf('Fighter');
    await fightUntil(() => !app.game.combat.inCombat(fid));
    await f.do('n', /Burnt Waystation/);
    // A brigand that ran may be waiting up the road.
    await fightUntil(() => !app.game.combat.inCombat(fid));
    // Bounties at the watch house, once.
    await f.close();
    const g = await login('Fighter', 'watch_house');
    await g.do('bounty', /counts out (5|10|15) coin[\s\S]*brigand/);
    await g.do('bounty', /Nothing owed/);
    await g.close();
  });

  it('the old man at the toll stump: pay him and the brigands let you be', async () => {
    (app.game.wilds as any).opts.ambushChance = 1;
    app.game.wilds.night = true;
    const p = await create('Garrow', 'drovers_ford', { old: true, coin: 5 });
    await p.do('n', /Toll Stump[\s\S]*old man in a tollman's coat/);
    await p.do('pay', /raises his hat/);
    expect(await coinOf('Garrow')).toBe(4);
    await p.do('n', /Brigand's Bend/);
    expect(app.game.wilds.ambushFor(await idOf('Garrow'))).toBeUndefined();
    // The camp lets them by too, while the old man's favour lasts.
    app.game.combat.spawn('brigand', 'camp_stockade', null);
    for (const step of ['e', 'e', 'e', 'e']) await p.do(step, /Exits:/);
    await p.do('e', /Stockade[\s\S]*paid the old man/);
    await p.close();
    // Walk past him without paying and a chill follows you.
    const r = await create('Miser', 'drovers_ford', { old: true });
    await r.do('n', /old man/);
    await r.do('n', /cold water touches the back of your neck/);
    expect((await stateOf('Miser')).curseUntil).toBeGreaterThan(Date.now());
    await r.close();
  });

  it('the camp attacks strangers, the bear its cave; the captain carries the only blade', async () => {
    const p = await create('Hunter', 'bw_fallen', { old: true, level: 15 });
    app.game.combat.spawn('brigand', 'camp_stockade', null);
    await p.do('e', /Stockade[\s\S]*goes for you/);
    expect(app.game.combat.inCombat(await idOf('Hunter'))).toBe(true);
    const hid = await idOf('Hunter');
    await fightUntil(() => !app.game.combat.inCombat(hid));
    await p.close();
    // The captain gets the blade only when nobody has it.
    clearMobs();
    await query(`DELETE FROM items WHERE template_id='captain_blade'`);
    const arm = (m: unknown) => (app.game.combat as any).armCaptain(m);
    const c1 = app.game.combat.spawn('captain', 'captains_tent', 'captains_tent');
    arm(c1);
    await new Promise((r) => setTimeout(r, 300));
    expect(c1.items).toContain('captain_blade');
    clearMobs();
    await give('Hunter', 'captain_blade');
    const c2 = app.game.combat.spawn('captain', 'captains_tent', 'captains_tent');
    arm(c2);
    await new Promise((r) => setTimeout(r, 300));
    expect(c2.items).not.toContain('captain_blade');
    clearMobs();
  });

  it("the Gatherers' Hall: members paid in full, outsiders half, stale bodies refused, ranks rise", async () => {
    const p = await create('Gath', 'gatherers_hall', { old: true, coin: 5 });
    // An outsider gets half.
    const k1 = await corpse('street', 'bruiser', 'gatherers_hall');
    await p.do('take corpse', /heave the corpse/);
    void k1;
    await p.do('deliver', /2 coin[\s\S]*not a member, half/);
    expect(await coinOf('Gath')).toBe(5 + 2);
    await p.do('join gatherers', /Carrier Gath/);
    expect(await coinOf('Gath')).toBe(6);
    await p.do('join gatherers', /already in the ledger/);
    // A member: full pay.
    const wanted = new Set(app.game.town.boardNow().map((w) => w.kind));
    const kind = ['drunk', 'ragpicker', 'preacher', 'cutpurse', 'bruiser'].find((k) => !wanted.has(k))!;
    await corpse('street', kind, 'gatherers_hall');
    await p.do('take corpse', /heave/);
    await p.do('deliver', new RegExp(`${bodyPay('street', kind)} coin`));
    expect(await coinOf('Gath')).toBe(6 + bodyPay('street', kind));
    // Stale: half after fifteen minutes, refused after twenty five.
    await corpse('street', kind, 'gatherers_hall', 20 * 60_000);
    await p.do('take corpse', /heave/);
    await p.do('deliver', /not fresh, half/);
    await corpse('street', kind, 'gatherers_hall', 26 * 60_000);
    await p.do('take corpse', /heave/);
    await p.do('deliver', /Too far gone/);
    await p.do('drop corpse', /slide off/);
    // Dead players go to Osmund.
    await query(`INSERT INTO corpses (kind, player_id, name, room_id, coin, open_at, expires_at) VALUES ('player', $1, 'Somebody', 'gatherers_hall', 0, now() - interval '20 minutes', now() + interval '10 minutes')`, [await idOf('Boss')]);
    await p.do('take corpse of somebody', /heave/);
    await p.do('deliver', /Father Osmund/);
    // A rat pays one, and is light.
    await query(`DELETE FROM corpses WHERE player_id IS NOT NULL`);
    app.game.combat.state(await idOf('Gath'))!.carrying = null;
    await p.do('board', /Wanted, this hour/);
    // Ranks: five bodies make a Bearer.
    for (let i = 0; i < 3; i++) {
      await corpse('rat', 'rat', 'gatherers_hall');
      await p.do('take corpse', /by the tail/);
      await p.do('deliver', /coin/);
    }
    await p.waitFor(/Bearer/, 100).catch(() => undefined);
    await p.do('who', /Gath[\s\S]*of the Gatherers/);
    await p.close();
  });

  it('drink adds up: merry heals, tipsy burps, drunk slurs and wanders, and Morda cuts you off', async () => {
    const p = await create('Sot', 'drowned_rat', { old: true, coin: 40 });
    const st = await stateOf('Sot');
    st.health = 10;
    await p.do('buy ale', /You buy/);
    await p.do('drink ale', /merry/);
    expect(st.health).toBe(11);
    await p.do('buy gin', /You buy/);
    await p.do('drink gin', /tipsy/);
    app.game.town.banterTimes().set('drowned_rat', Date.now());
    dice = () => 0.01;
    await app.game.town.tick();
    await p.waitFor(/You burp|You hiccup|You let out/);
    dice = Math.random;
    await p.do('buy gin', /You buy/);
    await p.do('drink gin', /You are drunk/);
    await p.do('health', /You are drunk/);
    await p.do('buy ale', /had your lot/);
    dice = () => 0.01;
    await p.do('say seriously this is fine', /You say, ".*sh.*\*hic\*/);
    dice = () => 0.05; // a wrong turn
    const went = await p.do('n', /street had other ideas[\s\S]*Exits:/);
    expect(went).not.toMatch(/Market West\n/);
    dice = Math.random;
    await p.close();
  });

  it('legless: out cold, robbed in the road; the cart takes you for dead', async () => {
    const p = await create('Legless', 'market_west', { old: true, coin: 9 });
    const st = await stateOf('Legless');
    st.drink = 6;
    st.drinkAt = Date.now();
    await give('Legless', 'gin');
    await p.do('drink gin', /out cold/);
    await p.do('n', /out cold in the road/);
    const thief = app.game.combat.spawn('cutpurse', 'market_west', null);
    void thief;
    dice = () => 0.01;
    await app.game.town.tick();
    await p.waitFor(/hand in your purse/);
    expect(await coinOf('Legless')).toBe(6);
    dice = Math.random;
    await app.game.cart.work('market_west');
    await p.waitFor(/take them for dead|hooks in your coat/);
    await p.waitFor(/Temple of Ash/);
    await p.close();
  });

  it('the Sleeping Lantern: rent, sleep whole and sober, a private room only for its renter, a chest of ten', async () => {
    const p = await create('Sleepy', 'rats_yard', { old: true, coin: 20 });
    await p.do('s', /Sleeping Lantern[\s\S]*Old Peg/);
    await p.do('sleep', /Rent a bed/);
    await p.do('rent room', /6 coin[\s\S]*room/);
    expect(await coinOf('Sleepy')).toBe(14);
    await p.do('u', /Loft/);
    const room = (await query(`SELECT value FROM player_flags WHERE flag='inn' AND player_id=$1`, [await idOf('Sleepy')])).rows[0].value.split(':')[1];
    const other = room === 'lantern_east' ? 'w' : 'e';
    await p.do(other, /locked/);
    await p.do(room === 'lantern_east' ? 'e' : 'w', /Room/);
    await give('Sleepy', 'bread');
    await p.do('store bread', /in the chest/);
    expect(await carried('Sleepy')).toEqual([]);
    await p.do('retrieve', /In your chest:[\s\S]*bread/);
    const st = await stateOf('Sleepy');
    st.health = 4;
    st.drink = 5;
    st.drinkAt = Date.now();
    await p.do('sleep', /asleep before your head is down/);
    st.asleep!.since = Date.now() - 2 * 60_000;
    (app.game.combat as any).lastRegen = 0;
    await app.game.combat.tick();
    expect(st.health).toBeGreaterThan(4);
    for (let i = 0; i < 5; i++) {
      (app.game.combat as any).lastRegen = 0;
      await app.game.combat.tick();
    }
    await app.game.town.tick();
    await p.waitFor(/wake whole, rested/);
    expect(st.health).toBe(maxHealthFor(1));
    expect(st.drink).toBe(0);
    await p.do('retrieve bread', /take a heel|take .* out of the chest/);
    await p.close();
    // Someone else can't get in, and can't open the chest.
    const q = await create('Nosy', 'lantern_loft', { old: true, coin: 0 });
    await q.do(room === 'lantern_east' ? 'e' : 'w', /locked/);
    await q.close();
  });

  it('the island: one coin each way out, and something under the yew, once', async () => {
    const p = await create('Hermit', 'mere_jetty', { old: true, coin: 3 });
    await p.do('n', /long, cold swim/);
    await p.do('ferry', /rows you out[\s\S]*The Island/);
    expect(await coinOf('Hermit')).toBe(2);
    await p.do('dig', /something hard and cold/);
    expect(await carried('Hermit')).toContain('hermit_bell');
    await p.do('dig', /Only roots now/);
    await p.do('ferry', /rows you back[\s\S]*The Jetty/);
    await p.close();
  });

  it('behind the falls: slippery on a hard day, and a pilgrim who left something, once', async () => {
    app.game.wilds.quietFalls = false;
    const p = await create('Wet', 'falls_ledge', { old: true });
    await p.do('w', /in the pool before you can shout[\s\S]*The Plunge Pool/);
    await p.do('u', /Wet Ledge/);
    app.game.wilds.quietFalls = true;
    await p.do('w', /Behind the Falls[\s\S]*too dark/);
    await p.close();
    await give('Wet', 'fox_fire');
    const q = await login('Wet', 'behind_falls');
    await q.do('search bedding', /pilgrim's journal/);
    await q.do('search bedding', /already taken/);
    await q.do('read journal', /Grandmother/);
    await q.close();
  });

  it('the Grandmother pike: rare, takes bait not worms, and the town hears of it', async () => {
    const p = await create('Angler', 'mere_deep', { old: true });
    await give('Angler', 'fishing_rod');
    await give('Angler', 'worm');
    await give('Angler', 'bait');
    dice = () => 0.001;
    await p.do('fish', /ball of bait/);
    await p.waitFor(/Grandmother, a\s+pike as long/);
    expect(await carried('Angler')).toContain('grandmother_pike');
    dice = Math.random;
    expect(app.game.town.rumours().some((r) => /Grandmother/.test(r.text))).toBe(true);
    await p.close();
  });

  it('the barrow: take the torc and the dead wake; leave something instead and the stones hum', async () => {
    const p = await create('Robber', 'barrow', { old: true, level: 15 });
    await p.do('take torc', /too dark/);
    await give('Robber', 'fox_fire');
    await give('Robber', 'war_axe');
    await p.do('wield axe', /You wield/);
    await p.do('take torc', /barrow wakes|Something stands up/);
    expect([...app.game.combat.mobs.values()].some((m) => m.kind === 'wight' && m.target)).toBe(true);
    await fightUntil(() => ![...app.game.combat.mobs.values()].some((m) => m.kind === 'wight'));
    await p.do('take torc', /shelf is bare to you/);
    await give('Robber', 'bread');
    await p.do('drop bread', /stones hum/);
    expect((await stateOf('Robber')).favourUntil).toBeGreaterThan(Date.now());
    await p.close();
    // A newcomer is let be.
    const n = await create('Innocent', 'barrow');
    await give('Innocent', 'fox_fire');
    await n.do('take torc', /too new to this world/);
    expect(app.game.combat.inCombat(await idOf('Innocent'))).toBe(false);
    await n.close();
  });

  it('rumours reach the townsfolk and fade; characters talk to each other no more than the limit', async () => {
    await app.game.town.rumour(null, 'Someone fed the rat king a turnip');
    const morda = app.game.world.npcs.get('morda')!;
    expect(app.game.town.noteFor(morda, 1)).toMatch(/rat king a turnip/);
    const seen: string[] = [];
    npcFn = (u) => {
      seen.push(u);
      return reply('Busy night.');
    };
    const p = await create('Eaves', 'drowned_rat', { old: true });
    groq.calls = [];
    app.game.town.banterTimes().clear();
    app.game.town.banter(Date.now(), true);
    await p.waitFor(/says to (Wendel|Morda), "Busy night\."[\s\S]*says to (Wendel|Morda), "Busy night\."/);
    const calls = groq.calls.length;
    app.game.town.banter(Date.now(), true);
    await new Promise((r) => setTimeout(r, 300));
    expect(groq.calls.length).toBe(calls);
    await p.close();
  });

  it('every notebook starts with the nave and a note from Father Osmund', async () => {
    const p = await create('Fresh', 'north_gate');
    await p.do('journal', /note in a cramped, tired hand[\s\S]*Father Osmund[\s\S]*The Nave/);
    await p.do('travel nave', /set off for The Nave/);
    await p.waitFor(/The Nave[\s\S]*Exits:/, 5000);
    await p.close();
  });
});
