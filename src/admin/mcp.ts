// A read only admin MCP server over stdio, so an assistant can check on the
// game: health, AI voices, who is about, and recent errors. It reads; it
// never writes, moves coin, or touches a player. Run it on the server with
//   node dist/admin/mcp.js
// and point an MCP client at that command.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { query, pool } from '../db/pool.js';
import { config } from '../config.js';

type Json = Record<string, unknown>;

export const TOOLS = [
  { name: 'game_health', description: 'Is Gallowmere up: the /health answer from the running server (players online, AI voices and their last call).', inputSchema: { type: 'object', properties: {} } },
  { name: 'player_counts', description: 'Players: total characters, new in the last day, seen in the last hour and day, and who is wanted by the watch.', inputSchema: { type: 'object', properties: {} } },
  { name: 'recent_errors', description: 'The last lines of the game\'s error log (pm2), newest last.', inputSchema: { type: 'object', properties: { lines: { type: 'number', description: 'How many lines, up to 200. Default 40.' } } } },
  { name: 'economy_summary', description: 'Coin in the world: total in purses and banks, and the biggest ledger movements in the last day.', inputSchema: { type: 'object', properties: {} } },
];

async function health(): Promise<Json> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(4000) });
    return { reachable: true, status: res.status, body: await res.json() };
  } catch (e) {
    return { reachable: false, error: String((e as Error).message ?? e) };
  }
}

async function players(): Promise<Json> {
  const { rows } = await query(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS new_today,
      count(*) FILTER (WHERE last_seen > now() - interval '1 hour')::int AS seen_last_hour,
      count(*) FILTER (WHERE last_seen > now() - interval '1 day')::int AS seen_last_day
    FROM players`);
  const wanted = await query(`SELECT p.name, round(sum(c.heat * power(0.5, extract(epoch FROM now() - c.at) / 7200)))::int AS heat
    FROM crimes c JOIN players p ON p.id = c.player_id WHERE NOT c.cleared GROUP BY p.name HAVING sum(c.heat * power(0.5, extract(epoch FROM now() - c.at) / 7200)) >= 40 ORDER BY heat DESC LIMIT 10`);
  return { ...rows[0], wanted: wanted.rows };
}

async function errors(lines: number): Promise<Json> {
  const n = Math.max(1, Math.min(200, Math.floor(lines) || 40));
  const file = process.env.GALLOWMERE_ERROR_LOG || join(homedir(), '.pm2', 'logs', 'gallowmere-error.log');
  try {
    const text = await readFile(file, 'utf8');
    return { file, lines: text.split('\n').filter(Boolean).slice(-n) };
  } catch {
    return { file, lines: [], note: 'No error log found at that path.' };
  }
}

async function economy(): Promise<Json> {
  const totals = await query('SELECT coalesce(sum(coin),0)::int AS purses, coalesce(sum(bank_coin),0)::int AS banks FROM players');
  const moves = await query(`SELECT reason, sum(change)::int AS change, count(*)::int AS times FROM coin_ledger
    WHERE created_at > now() - interval '1 day' GROUP BY reason ORDER BY abs(sum(change)) DESC LIMIT 10`);
  return { ...totals.rows[0], last_day: moves.rows };
}

export async function callTool(name: string, args: Json): Promise<Json> {
  switch (name) {
    case 'game_health': return health();
    case 'player_counts': return players();
    case 'recent_errors': return errors(Number(args?.lines ?? 40));
    case 'economy_summary': return economy();
    default: throw new Error(`unknown tool ${name}`);
  }
}

/** One JSON-RPC message in, at most one out. */
export async function handle(msg: Json): Promise<Json | null> {
  const id = msg.id as number | string | undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gallowmere-admin', version: '0.1.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const p = (msg.params ?? {}) as { name?: string; arguments?: Json };
      try {
        const out = await callTool(String(p.name), p.arguments ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: String((e as Error).message ?? e) }], isError: true });
      }
    }
    default:
      if (id === undefined) return null; // a notification: nothing to say
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
  }
}

if (process.argv[1] && /admin[\\/]mcp\.(js|ts)$/.test(process.argv[1])) {
  const rl = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    const job = handle(msg).then((out) => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  // The client hung up: answer what is in flight, then close the database.
  rl.on('close', () => { void Promise.allSettled([...pending]).then(() => pool.end()); });
}
