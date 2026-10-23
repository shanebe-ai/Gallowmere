import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config.js';
import { query } from './db/pool.js';
import { AIService } from './ai/service.js';
import { GroqProvider } from './ai/providers/groq.js';
import { GeminiProvider } from './ai/providers/gemini.js';
import type { ChatProvider } from './ai/types.js';
import { NpcBrain } from './npc/brain.js';
import { Game } from './game/game.js';
import { World } from './game/world.js';
import type { Connection } from './game/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultProviders(): Array<{ provider: ChatProvider; rpm: number }> {
  return [
    { provider: new GroqProvider(config.ai.groqKey, config.ai.groqModel, config.ai.groqTimeoutMs), rpm: config.ai.groqRpm },
    { provider: new GeminiProvider(config.ai.geminiKey, config.ai.geminiModel, config.ai.geminiTimeoutMs), rpm: config.ai.geminiRpm },
  ];
}

export async function createApp(opts: { providers?: Array<{ provider: ChatProvider; rpm: number }> } = {}) {
  const world = new World();
  await world.load();

  const ai = new AIService(opts.providers ?? defaultProviders());
  const brain = new NpcBrain({
    ai,
    dailyCap: config.ai.dailyCapPerPlayer,
    maxTokens: config.ai.maxOutputTokens,
    async usedToday(playerId) {
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM ai_usage
          WHERE player_id=$1 AND provider <> 'scripted' AND created_at > date_trunc('day', now())`,
        [playerId],
      );
      return rows[0].n;
    },
    async logUsage(r) {
      await query(
        `INSERT INTO ai_usage (player_id, npc_id, provider, model, tokens_in, tokens_out, latency_ms, fallback_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.playerId, r.npcId, r.provider, r.model, r.tokensIn, r.tokensOut, r.latencyMs, r.fallbackUsed],
      );
    },
    async logFlagged(playerId, source, text) {
      await query('INSERT INTO flagged_lines (player_id, source, text) VALUES ($1,$2,$3)', [playerId, source, text]);
    },
  });

  const game = new Game(world, brain);

  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({ ok: true, online: game.onlineNames().length, ai: ai.hasProvider() });
  });
  app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 4096, pingInterval: 20000, pingTimeout: 20000 });

  io.on('connection', (socket) => {
    const conn: Connection = {
      ip: socket.handshake.address,
      send: (text) => socket.emit('out', text),
      setMode: (mode) => socket.emit('mode', mode),
      setStatus: (status) => socket.emit('status', status),
      setToken: (token) => socket.emit('session', token),
      close: () => setTimeout(() => socket.disconnect(true), 50),
    };

    // Inputs are queued per socket so commands run in the order typed.
    let chain: Promise<unknown> = Promise.resolve();
    let session: Awaited<ReturnType<Game['connect']>> | null = null;
    let started = false;
    let lastSecond = 0;
    let inSecond = 0;

    socket.on('hello', (payload: { token?: string; cols?: number } = {}) => {
      if (started) return;
      started = true;
      const token = typeof payload?.token === 'string' ? payload.token.slice(0, 100) : null;
      chain = chain.then(async () => {
        session = await game.connect(conn, token, Number(payload?.cols));
      });
    });

    socket.on('size', (cols: number) => session?.setCols(Number(cols)));

    socket.on('line', (line: unknown) => {
      if (typeof line !== 'string') return;
      // Flood guard: at most 10 lines a second.
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== lastSecond) {
        lastSecond = sec;
        inSecond = 0;
      }
      if (++inSecond > 10) return;
      chain = chain
        .then(() => session && game.input(session, line.slice(0, 1000)))
        .catch((err) => {
          console.error('input failed:', err);
          session?.out('Something went wrong in the fog. Try that again.');
        });
    });

    socket.on('disconnect', () => {
      chain = chain.then(() => session && game.disconnect(session)).catch((err) => console.error('disconnect failed:', err));
    });
  });

  return { app, server, io, game, world };
}
