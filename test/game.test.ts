import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { pool, query } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { stripAnsi } from '../src/game/text.js';
import { FakeProvider, reply } from './fakes.js';
import type { ChatRequest } from '../src/ai/types.js';

let url = '';
let app: Awaited<ReturnType<typeof createApp>>;
let morda: (req: ChatRequest) => string = () => reply('Aye.');
// Fake Morda only sees the latest line, the way a test can reason about it; calls keep the full prompt.
const groq = new FakeProvider('groq', (req) => morda({ ...req, user: req.user.split('[Now]\n').pop()! }), 2000);
const sockets: Socket[] = [];

class Player {
  socket: Socket;
  buf = '';
  token: string | null = null;
  mode = { echo: true, prompt: '' };
  status: any = null;

  constructor(token?: string | null, cols = 200, keepScreen = false) {
    this.socket = ioClient(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(this.socket);
    this.socket.on('out', (t: string) => (this.buf += stripAnsi(t)));
    this.socket.on('session', (t: string | null) => (this.token = t));
    this.socket.on('mode', (m) => (this.mode = m));
    this.socket.on('status', (s) => (this.status = s));
    this.socket.on('connect', () => this.socket.emit('hello', { token: token ?? null, cols, keepScreen }));
  }

  send(line: string) {
    this.socket.emit('line', line);
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
    // Stay under the server's flood guard of 10 lines a second.
    await new Promise((r) => setTimeout(r, 110));
    this.send(line);
    return this.waitFor(re);
  }

  /** Drops the connection without quitting, like a network blip. */
  drop() {
    this.socket.disconnect();
  }

  /** Quits cleanly and waits for the server to save. */
  async close() {
    if (this.socket.connected) {
      this.send('quit');
      await new Promise((r) => this.socket.once('disconnect', r));
      // The server saves the character after the socket closes; give it a moment.
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function create(name: string, password = 'secret1') {
  const p = new Player();
  await p.waitFor(/By what name/);
  await p.do(name, /Make a new character/);
  await p.do('y', /Choose a password/);
  expect(p.mode.echo).toBe(false);
  await p.do(password, /Once more/);
  await p.do(password, /Exits:/);
  return p;
}

async function login(name: string, room?: string, password = 'secret1') {
  if (room) await query('UPDATE players SET room_id=$2 WHERE lower(name)=lower($1)', [name, room]);
  const p = new Player();
  await p.waitFor(/By what name/);
  await p.do(name, /Welcome back/);
  await p.do(password, /Exits:/);
  return p;
}

beforeAll(async () => {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = await createApp({ providers: [{ provider: groq, rpm: 1000 }], telnetPort: 0 });
  await new Promise((r) => (app.telnet!.listening ? r(null) : app.telnet!.once('listening', r)));
  await new Promise<void>((r) => app.server.listen(0, r));
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  morda = () => reply('Aye.');
  groq.calls = [];
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  app.game.stop();
  app.io.close();
  app.telnet?.close();
  await new Promise((r) => app.server.close(r));
  await pool.end();
});

describe('Gallowmere end to end', () => {
  it('serves the health check and the client page', async () => {
    const health = await (await fetch(`${url}/health`)).json();
    expect(health.ok).toBe(true);
    const page = await (await fetch(url)).text();
    expect(page).toContain('GALLOWMERE');
  });

  it('two players see each other walk and talk', async () => {
    const a = await create('Shane');
    const b = await create('Bob');
    await a.waitFor(/Bob steps out of the fog/);
    await a.do('look', /Players:\s+Bob/);

    b.send('say evening');
    await a.waitFor(/Bob says, "evening"/);
    b.send(': tips his hat');
    await a.waitFor(/Bob tips his hat/);

    b.send('s');
    await a.waitFor(/Bob leaves south/);
    a.send('s');
    await b.waitFor(/Shane arrives from the north/);

    await a.do('who', /Bob\s+Gate Road[\s\S]*Shane\s+Gate Road/);
    expect(a.status.online).toBe(2);
    expect(a.status.exits).toEqual(['north', 'south', 'east', 'west']);
    await a.close();
    await b.close();
  });

  it('rejects bad names, wrong passwords and bad moves', async () => {
    const p = new Player();
    await p.waitFor(/By what name/);
    await p.do('x1', /3 to 16 letters/);
    await p.do('morda', /taken by someone/);
    await p.do('Shane', /Welcome back/);
    await p.do('wrongpass', /Wrong password/);
    await p.do('secret1', /Exits:/);
    await p.do('u', /can't go that way/);
    await p.do('frobnicate wildly', /Huh\?|What\?|doesn't mean|fog swallows/);
    await p.close();
  });

  it('lets a name carry accents, and treats the plain spelling as the same character', async () => {
    const p = new Player();
    await p.waitFor(/By what name/);
    await p.do('No3lle', /3 to 16 letters/);
    await p.do('Él', /3 to 16 letters/);
    await p.do('Dacé', /taken by someone/);
    p.socket.disconnect();

    const a = await create('Noëlle');
    const b = await create('Piotr');
    await b.do('look at noelle', /Noëlle is a stranger to these streets/);
    await b.close();
    await a.close();

    // The plain spelling at the gate is her, not a new character.
    const again = new Player();
    await again.waitFor(/By what name/);
    await again.do('Noelle', /Welcome back/);
    await again.do('secret1', /Exits:/);
    await again.close();

    // Capitals with the accent are her too.
    const caps = new Player();
    await caps.waitFor(/By what name/);
    await caps.do('NOËLLE', /Welcome back/);
    await caps.do('secret1', /Exits:/);
    await caps.close();
  });

  it('emotes: alone, at a player, at a character who reacts, and in your own words', async () => {
    morda = () => reply('', { type: 'none' }, 'waves back with a dishrag');
    await (await create('Emi')).close();
    await (await create('Ozzy')).close();
    const a = await login('Emi', 'drowned_rat');
    const b = await login('Ozzy', 'drowned_rat');
    await a.do('wave', /You wave\./);
    await b.waitFor(/Emi waves\./);
    await a.do('laugh at ozzy', /You laugh at Ozzy\./);
    await b.waitFor(/Emi laughs at you\./);
    await a.do('wave morda', /You wave at Morda the barkeep\.[\s\S]*Morda waves back with a dishrag/);
    await a.do('dance wildly', /You dance wildly\./);
    await b.waitFor(/Emi dances wildly\./);
    await a.do('hug nobodyhere', /You don't see nobodyhere here\./);
    await a.do('wave at nobodyhere', /You don't see nobodyhere here\./);
    await a.do('wave nobodyhere', /You don't see nobodyhere here\./);
    await a.do('hug ozzy', /You hug Ozzy\./);
    await b.waitFor(/Emi hugs you\./);
    await a.do('emotes', /Emotes[\s\S]*wave/);
    await a.do('/nod', /You nod\./);
    await a.close();
    await b.close();
  });

  it('a new name needs a plain y or n before anything else happens', async () => {
    const p = new Player();
    await p.waitFor(/By what name/);
    await p.do('Quinn', /Make a new character/);
    await p.do('hunter22', /Please choose yes \(y\) or no \(n\)/);
    await p.do('maybe', /Please choose yes \(y\) or no \(n\)/);
    await p.do('no', /By what name/);
    await p.do('Quinn', /Make a new character/);
    await p.do('yes', /Choose a password/);
    p.socket.disconnect();
  });

  it('saves aliases per character', async () => {
    const p = await login('Shane');
    await p.do('alias hi say Hello there', /Alias set/);
    await p.do('hi friend', /You say, "Hello there friend"/);
    await p.close();
    const q = await login('Shane');
    await q.do('alias', /hi\s+say Hello there/);
    await q.do('unalias hi', /removed/);
    await q.close();
  });

  it('Morda remembers what you told her after you log out and back in', async () => {
    morda = (req) =>
      req.user.includes('tanner')
        ? reply('A tanner. Thought I smelled it.', { type: 'remember', note: 'works as a tanner' }, 'wrinkles her nose')
        : reply('What will it be?');

    const p = await login('Shane', 'drowned_rat');
    expect(p.status.room).toBe('The Drowned Rat');
    await p.do('talk morda I am a tanner by trade', /Morda wrinkles her nose[\s\S]*Morda says to you, "A tanner\. Thought I smelled it\."/);
    await p.close();

    const { rows } = await query("SELECT notes FROM npc_memory WHERE npc_id='morda'");
    expect(rows[0].notes).toEqual(['works as a tanner']);

    groq.calls = [];
    const q = await login('Shane');
    expect(q.status.room).toBe('The Drowned Rat');
    await q.do('say evening Morda', /Morda says to you, "What will it be\?"/);
    expect(groq.calls[0].user).toContain('works as a tanner');
    await q.close();
  });

  it('naming the barkeep in a say reaches her, and others in the room hear the reply', async () => {
    const a = await login('Shane', 'drowned_rat');
    const b = await login('Bob', 'drowned_rat');
    morda = () => reply('Keep it down.');
    a.send('say barkeep, two ales');
    await b.waitFor(/Morda says to Shane, "Keep it down\."/);
    await a.waitFor(/Morda says to you, "Keep it down\."/);
    await a.close();
    await b.close();
  });

  it('falls back to scripted lines when the AI is down', async () => {
    morda = () => {
      throw new Error('503');
    };
    const p = await login('Shane', 'drowned_rat');
    await p.do('ask morda about the sewers', /You ask Morda the barkeep about the sewers/);
    // A question, so the fallback is one of Morda's answers to questions.
    await p.waitFor(/Ask me again when I'm less busy/);
    const { rows } = await query("SELECT provider, fallback_used FROM ai_usage ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toEqual({ provider: 'scripted', fallback_used: true });
    await p.close();
  });

  it('a refusal makes Morda ignore you for a while', async () => {
    morda = () => reply('Out of my sight.', { type: 'refuse' });
    const p = await login('Shane', 'drowned_rat');
    await p.do('talk morda you water down the ale', /Out of my sight/);
    await p.do('talk morda come on', /Morda turns away from Shane/);
    expect(groq.calls).toHaveLength(1);
    await p.close();
  });

  it('blocks flagged player text', async () => {
    const p = await login('Bob');
    const slur = Buffer.from('cmV0YXJk', 'base64').toString();
    await p.do(`say you ${slur}`, /words catch in your throat/);
    const { rows } = await query("SELECT count(*)::int AS n FROM flagged_lines WHERE source='player'");
    expect(rows[0].n).toBe(1);
    await p.close();
  });

  it('resumes a dropped connection with its token, quietly', async () => {
    const a = await login('Shane');
    const b = await login('Bob');
    const token = a.token;
    expect(token).toBeTruthy();
    a.drop();
    await new Promise((r) => setTimeout(r, 200));
    const a2 = new Player(token);
    await a2.waitFor(/\[Reconnected\][\s\S]*Exits:/);
    await new Promise((r) => setTimeout(r, 200));
    expect(b.buf).not.toMatch(/Shane fades/);
    await a2.close();
    await b.close();
  });

  it('a page that kept its screen is not shown the room again on reconnect', async () => {
    const a = await login('Shane');
    const token = a.token;
    a.drop();
    await new Promise((r) => setTimeout(r, 200));
    const a2 = new Player(token, 200, true);
    await a2.waitFor(/\[Reconnected\]/);
    await new Promise((r) => setTimeout(r, 400));
    expect(a2.buf).not.toMatch(/Exits:/);
    expect(a2.status?.room).toBeTruthy();
    await a2.do('look', /Exits:/);
    await a2.close();
  });

  it('a second login pushes the first connection out', async () => {
    const a = await login('Bob');
    const a2 = await login('Bob');
    await a.waitFor(/stepped into your boots/);
    await a2.do('who', /Bob/);
    await a2.close();
  });

  it('aistats is admin only and reports usage', async () => {
    const bob = await login('Bob');
    await bob.do('aistats', /Huh\?|What\?|doesn't mean|fog swallows/);
    await bob.close();
    const shane = await login('Shane');
    await shane.do('aistats', /NPC lines, last 24 hours[\s\S]*Shane/);
    await shane.close();
  });

  it('aibench and aimodel are admin only, time each ai& model and switch the live one', async () => {
    const seen: string[] = [];
    const fake = {
      model: 'deepseek-ai/deepseek-v4-flash',
      isConfigured: () => true,
      models: async () => ['deepseek-ai/deepseek-v4-flash', 'openai/gpt-oss-120b', 'moonshotai/kimi-k3'],
      chat: async (req: any, _signal: AbortSignal, model?: string) => {
        seen.push(model!);
        if (model === 'openai/gpt-oss-120b') return { text: 'not json at all', tokensIn: 1, tokensOut: 1 };
        return { text: reply('Mind Gerald, dearie.', { type: 'none' }, 'pats the heron'), tokensIn: 1, tokensOut: 1 };
      },
    };
    const origAi = (app.game as any).opts.ai;
    (app.game as any).opts.aiand = fake;
    try {
      const bob = await login('Bob');
      await bob.do('aibench', /Huh\?|What\?|doesn't mean|fog swallows/);
      await bob.do('aimodel x', /Huh\?|What\?|doesn't mean|fog swallows/);
      await bob.close();
      const shane = await login('Shane');
      await shane.do('aibench models', /ai& models on this key \(3\)[\s\S]*deepseek-ai\/deepseek-v4-flash  \(in use\)[\s\S]*moonshotai\/kimi-k3/);
      await shane.do('aibench', /Benching 2 model\(s\)/);
      await shane.waitFor(/deepseek-ai\/deepseek-v4-flash  avg \d+ ms, slowest \d+ ms, 3\/3 usable[\s\S]*\(pats the heron\) "Mind Gerald, dearie\."/);
      await shane.waitFor(/openai\/gpt-oss-120b  avg \d+ ms, slowest \d+ ms, 0\/3 usable[\s\S]*not usable: not json at all/);
      await shane.waitFor(/Fastest with every reply usable: deepseek-ai\/deepseek-v4-flash/);
      // The heavy model isn't benched unless named.
      expect(seen).not.toContain('moonshotai/kimi-k3');
      await shane.do('aimodel openai/gpt-oss-120b', /ai& model is now openai\/gpt-oss-120b/);
      expect(fake.model).toBe('openai/gpt-oss-120b');
      await shane.do('aimodel', /ai& model in use: openai\/gpt-oss-120b/);
      // aistats leads with each provider: whether it has a key, and how its last call went.
      (app.game as any).opts.ai = {
        status: () => [
          { name: 'aiand', model: 'deepseek-ai/deepseek-v4-flash', configured: true, last: { ok: true, at: Date.now(), latencyMs: 2100 } },
          { name: 'groq', model: 'llama-3.1-8b-instant', configured: false },
          { name: 'gemini', model: 'gemini-2.5-flash-lite', configured: true, last: { ok: false, at: Date.now(), error: 'Gemini API error 403: key revoked', latencyMs: 90 } },
        ],
      };
      (app.game as any).opts.ai.ping = async () => [
        { name: 'aiand', model: 'deepseek-ai/deepseek-v4-flash', configured: true, ok: true, latencyMs: 900 },
        { name: 'groq', model: 'llama-3.1-8b-instant', configured: true, ok: false, latencyMs: 120, error: 'Groq API error 401: Invalid API Key' },
        { name: 'gemini', model: 'gemini-2.5-flash-lite', configured: false },
      ];
      await shane.do('aiping', /aiand +deepseek-ai\/deepseek-v4-flash  ok, 900 ms[\s\S]*groq +llama-3.1-8b-instant  failed after 120 ms: Groq API error 401: Invalid API Key[\s\S]*gemini +gemini-2.5-flash-lite  no key set/);
      await shane.do('aistats', /AI providers, in the order tried[\s\S]*aiand +deepseek-ai\/deepseek-v4-flash  ok, 2100 ms[\s\S]*groq +llama-3.1-8b-instant  no key set[\s\S]*gemini +gemini-2.5-flash-lite  failed 0 min ago: Gemini API error 403: key revoked/);
      await shane.close();
    } finally {
      (app.game as any).opts.aiand = undefined;
      (app.game as any).opts.ai = origAi;
    }
  });

  it('caps player input at 300 characters and strips escape codes', async () => {
    const p = await login('Bob');
    await p.do(`say \x1b[31m${'a'.repeat(400)}`, /You say,\s+"a{290,300}"/);
    await p.close();
    const { rows } = await query("SELECT 1");
    expect(rows).toHaveLength(1);
  });
  it('talking to the guard works the natural ways', async () => {
    morda = () => reply('Evening, friend.');
    const guard = /Dace says to you, "Evening, friend\."/;
    const p = await login('Bob', 'north_gate');
    // Alone with Dace, a plain say with no name in it is said to him.
    await p.do('say lovely fog today', /You say, "lovely fog today"/);
    await p.waitFor(guard);
    // With another player about, an unnamed say is for them, not the guard.
    const q = await login('Shane', 'north_gate');
    await new Promise((r) => setTimeout(r, 300));
    await q.do('say lovely fog today', /You say, "lovely fog today"/);
    await new Promise((r) => setTimeout(r, 700));
    expect(q.buf).not.toMatch(/Dace says/);
    await q.close();
    await p.do('say hi guard', /You say, "hi guard"/);
    await p.waitFor(guard);
    await p.do('hello guard', /You say, "hello guard"/);
    await p.waitFor(guard);
    await p.do('talk guard', /You say to Dace, "Hello\."/);
    await p.waitFor(guard);
    await p.do('say to guard nice weather', /You say to Dace, "nice weather"/);
    await p.waitFor(guard);
    // Mid conversation, a plain say carries on with Dace.
    await p.do('say lovely fog today', /You say, "lovely fog today"/);
    await p.waitFor(guard);
    await p.close();
  });

  it('attacking is turned away for now', async () => {
    const p = await login('Bob', 'north_gate');
    await p.do('attack guard', /size up Dace and think better of it/);
    await p.do('kill nobody', /nobody like that here/);
    await p.close();
  });
  it('lists people, players and things under the room, and things can be looked at', async () => {
    const a = await login('Shane', 'drowned_rat');
    const b = await login('Bob', 'drowned_rat');
    const seen = await a.do('look', /Exits:/);
    expect(seen).toMatch(/People:\s+Morda the barkeep/);
    expect(seen).toMatch(/Players:\s+Bob/);
    expect(seen).toMatch(/You see:\s+the stained curtain, the dice game/);
    await a.do('look curtain', /heavy curtain/);
    await a.do('l dice', /battered cup of dice/);
    await a.do('look barkeep', /broad, tired woman[\s\S]*To talk: talk morda/);
    await a.close();
    await b.close();
  });

  it('wraps long lists one name per line on narrow screens', async () => {
    const p = new Player(null, 38);
    await p.waitFor(/By what name/);
    await p.do('Bob', /Welcome back/);
    await query("UPDATE players SET room_id='river_docks' WHERE name='Bob'");
    const seen = await p.do('secret1', /Exits:/);
    expect(seen).toMatch(/You see: the stacked crates,\n {9}the harbourmaster's shed/);
    await p.close();
  });

  it('a plain say carries on a conversation with Morda', async () => {
    await (await create('Cara')).close();
    morda = (req) =>
      req.user.includes('whiskey') ? reply('Whiskey it is. Coin first.') : reply('What do you want?');
    const p = await login('Cara', 'drowned_rat');
    await p.do('talk morda evening', /Morda says to you, "What do you want\?"/);
    await p.do('say a whiskey', /Morda says to you, "Whiskey it is\. Coin first\."/);
    await p.do("' make it a double", /Morda says to you/);
    expect(groq.calls).toHaveLength(3);
    await p.close();
  });

  it('a plain say to another player does not pull Morda in', async () => {
    morda = () => reply('What do you want?');
    const a = await login('Cara', 'drowned_rat');
    const b = await login('Bob', 'drowned_rat');
    await a.do('talk morda evening', /Morda says to you/);
    await a.do('say Bob, buy me a drink', /You say/);
    await a.do("' never mind", /You say/);
    await new Promise((r) => setTimeout(r, 300));
    // The second line has no name in it, so Morda answers that one only.
    expect(groq.calls).toHaveLength(2);
    await a.close();
    await b.close();
  });

  it('a conversation does not follow you out of the room', async () => {
    morda = () => reply('What do you want?');
    const p = await login('Cara', 'drowned_rat');
    await p.do('talk morda evening', /Morda says to you/);
    await p.do('n', /Exits:/);
    await p.do('say anyone here?', /You say/);
    await new Promise((r) => setTimeout(r, 300));
    expect(groq.calls).toHaveLength(1);
    await p.close();
  });
  it('things in a room can be looked at and used in plain words', async () => {
    morda = (req) =>
      req.user.includes('yank') ? reply('Hands off my curtain, damp one.', { type: 'none' }, 'slaps the bar') : reply('What?');
    await (await create('Dana')).close();
    const p = await login('Dana', 'drowned_rat');
    await p.do('look at the curtain', /heavy curtain[\s\S]*You could: open, take, touch\./);
    await p.do('x the stained curtain', /heavy curtain/);
    await p.do('take the curtain', /good yank/);
    await p.waitFor(/Morda slaps the bar\.[\s\S]*Morda says to you, "Hands off my curtain, damp one\."/);
    expect(groq.calls.at(-1)!.user).toContain('Right in front of you, Dana grabs your stained curtain');
    await p.do('pull curtain', /You could slip\s+through to the west/);
    await p.do('play dice', /Locals only/);
    await p.do('smell the dice', /smells like the rest of Gallowmere/);
    await p.do('w', /The Back Room/);
    await p.do('pick up the ledger', /put it\s+back exactly where it was/);
    await p.do('read ledger', /The Drowned Rat,\s+everything/);
    await p.do('juggle the barrels', /Huh\?|What\?|doesn't mean|fog swallows/);
    await p.do('take the moon', /don't see that here/);
    await p.close();
  });

  it('verbs work on people too', async () => {
    morda = (req) => (req.user.includes('pokes you') ? reply('Poke me again and lose the finger.') : reply('What?'));
    const a = await login('Dana', 'drowned_rat');
    const b = await login('Bob', 'drowned_rat');
    await a.do('poke morda', /You poke Morda the barkeep\./);
    await a.waitFor(/lose the finger/);
    await b.waitFor(/Dana pokes Morda the barkeep\./);
    await a.do('poke bob', /You poke Bob\./);
    await b.waitFor(/Dana pokes you\./);
    await a.close();
    await b.close();
  });
  it('serves security headers', async () => {
    const res = await fetch(url);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('locks a character after too many wrong passwords from anywhere', async () => {
    await (await create('Eve')).close();
    // Simulate ten recent failures from other addresses; the right password is still refused.
    const g = app.game as any;
    g.accountFails.set('eve', Array.from({ length: 10 }, () => Date.now()));
    const p = new Player();
    await p.waitFor(/By what name/);
    await p.do('Eve', /Welcome back/);
    await p.do('secret1', /locked for a few minutes/);
    g.accountFails.delete('eve');
    p.drop();
  });

  it('quitting revokes the saved reconnect token', async () => {
    const a = await login('Bob');
    const token = a.token;
    await a.close();
    const b = new Player(token);
    await b.waitFor(/By what name/);
    b.drop();
  });

  it('plays over real telnet alongside the browser', async () => {
    const port = (app.telnet!.address() as AddressInfo).port;
    const raw: Buffer[] = [];
    let text = '';
    const sock = net.connect(port, '127.0.0.1');
    sock.on('data', (d: Buffer) => {
      raw.push(d);
      // Drop telnet commands for the text view.
      const clean: number[] = [];
      for (let i = 0; i < d.length; i++) {
        if (d[i] === 255) {
          if (d[i + 1] === 250) { while (i < d.length && !(d[i] === 255 && d[i + 1] === 240)) i++; i++; }
          else i += d[i + 1] >= 251 ? 2 : 1;
          continue;
        }
        clean.push(d[i]);
      }
      text += stripAnsi(Buffer.from(clean).toString('utf8'));
    });
    const waitText = async (re: RegExp) => {
      const start = Date.now();
      while (Date.now() - start < 4000) {
        const m = text.match(re);
        if (m) { text = text.slice((m.index ?? 0) + m[0].length); return; }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`telnet timed out waiting for ${re}. Got:\n${text}`);
    };
    await new Promise((r) => sock.once('connect', r));
    // Report a 60 column window: IAC SB NAWS 0 60 0 24 IAC SE
    sock.write(Buffer.from([255, 250, 31, 0, 60, 0, 24, 255, 240]));
    await waitText(/By what name/);
    expect(Buffer.concat(raw).includes(Buffer.from([255, 253, 31]))).toBe(true); // asked for window size

    const web = await login('Bob', 'north_gate');
    await query("UPDATE players SET room_id='north_gate' WHERE name='Shane'");
    sock.write('Shane\r\n');
    await waitText(/Welcome back/);
    expect(Buffer.concat(raw).includes(Buffer.from([255, 251, 1]))).toBe(true); // echo off for the password
    sock.write('secret1\r\n');
    await waitText(/The North Gate[\s\S]*Players: Bob[\s\S]*Exits:/);
    expect(Buffer.concat(raw).includes(Buffer.from([255, 252, 1]))).toBe(true); // echo back on
    await web.waitFor(/Shane steps out of the fog/);

    sock.write('say evening from telnet\r\n');
    await web.waitFor(/Shane says, "evening from telnet"/);
    web.send('say hello telnet');
    await waitText(/Bob says, "hello telnet"/);
    sock.write('look at the gibbet\r\n');
    await waitText(/iron cage/);
    // Lines are wrapped to the 60 columns the client reported.
    sock.write('look\r\n');
    await waitText(/Exits:/);
    sock.write('quit\r\n');
    await new Promise((r) => sock.once('close', r));
    await web.waitFor(/Shane fades into the fog/);
    await web.close();
  });

  it('lets an older telnet client create an accented name sent as Latin-1 bytes', async () => {
    const port = (app.telnet!.address() as AddressInfo).port;
    const sock = net.createConnection(port, '127.0.0.1');
    let text = '';
    sock.on('data', (d: Buffer) => {
      const clean: number[] = [];
      for (let i = 0; i < d.length; i++) {
        if (d[i] === 255) {
          if (d[i + 1] === 250) { while (i < d.length && !(d[i] === 255 && d[i + 1] === 240)) i++; i++; }
          else i += d[i + 1] >= 251 ? 2 : 1;
          continue;
        }
        clean.push(d[i]);
      }
      text += stripAnsi(Buffer.from(clean).toString('utf8'));
    });
    const waitText = async (re: RegExp) => {
      const start = Date.now();
      while (Date.now() - start < 4000) {
        const m = text.match(re);
        if (m) { text = text.slice((m.index ?? 0) + m[0].length); return; }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`telnet timed out waiting for ${re}. Got:\n${text}`);
    };
    await new Promise((r) => sock.once('connect', r));
    await waitText(/By what name/);
    // An older client sends é as the single byte 0xE9, not as UTF-8.
    sock.write(Buffer.from([0x4e, 0x6f, 0xe9, 0x6c, 0x69, 0x65, 0x0d, 0x0a])); // Noélie
    await waitText(/Make a new character called Noélie/);
    sock.write('y\r\n');
    await waitText(/Choose a password/);
    sock.write('secret1\r\n');
    await waitText(/Once more/);
    sock.write('secret1\r\n');
    await waitText(/Exits:/);
    sock.write('quit\r\n');
    await new Promise((r) => sock.once('close', r));
  });
});

describe('the law: heat and witnesses (milestone 4 step 2)', () => {
  async function agedPair(a: string, b: string, room?: string) {
    const pa = await create(a);
    const pb = await create(b);
    await pa.close();
    await pb.close();
    await query("UPDATE players SET created_at = now() - interval '3 hours' WHERE name IN ($1, $2)", [a, b]);
    const la = await login(a, room);
    const lb = await login(b, room);
    return { la, lb };
  }

  it('a first blow inside the walls is written down, seen by the gate guard', async () => {
    const { la, lb } = await agedPair('Ash', 'Bram');
    await la.do('attack bram', /You attack Bram!/);
    await la.do('wanted', /Your heat: 10\. The watch has heard your name, nothing more\./);
    await la.waitFor(/Struck Bram at The North Gate, seen by [^.]*Dace/);
    await la.close();
    await lb.close();
  });

  it('the same blow out on the moor is no crime at all', async () => {
    const { la, lb } = await agedPair('Cato', 'Drew', 'moor_road');
    await la.do('attack drew', /You attack Drew!/);
    const seen = await la.do('wanted', /Your heat: 0\. The watch has no quarrel with you\./);
    expect(seen).not.toMatch(/Struck/);
    await la.close();
    await lb.close();
  });

  it('heat cools by half every two hours, and a body tells the tale', async () => {
    const p = await create('Elba');
    await p.close();
    const { rows } = await query('SELECT id FROM players WHERE name = $1', ['Elba']);
    await query(
      "INSERT INTO crimes (player_id, kind, room_id, victim, witnesses, seen, heat, at) VALUES ($1, 'murder', 'market_east', 'Bram', '[]', false, 40, now() - interval '2 hours')",
      [rows[0].id],
    );
    const again = await login('Elba');
    await again.do('wanted', /Your heat: 20\. The watch is watching you\./);
    await again.waitFor(/Murdered Bram at Market East, nobody saw it done, but the body told the tale\./);
    const dace = app.world.npcsIn('north_gate').find((n) => n.id === 'dace')!;
    const note = await app.game.law.noteFor(dace, { id: rows[0].id, name: 'Elba' });
    expect(note).toContain('wanted by the watch (heat 20)');
    const { rows: clean } = await query('SELECT id FROM players WHERE name = $1', ['Bram']);
    expect(await app.game.law.noteFor(dace, { id: clean[0].id, name: 'Bram' })).toBeUndefined();
    await again.close();
  });
});
