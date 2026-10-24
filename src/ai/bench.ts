import { buildPrompt, parseReply, type NpcCard } from '../npc/brain.js';
import type { ChatRequest, ChatResult } from './types.js';

/** Anything that can answer a chat on a named model (the ai& provider). */
export interface BenchProvider {
  chat(req: ChatRequest, signal: AbortSignal, model?: string): Promise<ChatResult>;
  models(signal: AbortSignal): Promise<string[]>;
}

/** The ai& provider as the game sees it: its model can be switched while running. */
export interface LiveModel extends BenchProvider {
  model: string;
  isConfigured(): boolean;
}

/** The fast models worth trying first. Heavy ones (Kimi, GLM 5.3, DeepSeek Pro) can be named by hand. */
export const BENCH_DEFAULTS = [
  'deepseek-ai/deepseek-v4-flash',
  'deepseek-ai/deepseek-v4.1-flash',
  'openai/gpt-oss-120b',
  'google/gemma-4-31b-it',
  'zai-org/glm-5.3-flash',
  'qwen/qwen3.6-27b',
  'motif-technologies/motif-3',
];

/** A few things a player might say, from easy to awkward. */
export const BENCH_LINES = ['hi', "what's the story with that heron?", 'my brother died of the plague last week'];

export interface BenchRow {
  model: string;
  times: number[];
  valid: number;
  errors: string[];
  samples: string[];
}

/** Runs the same short conversation on each model and reports speed, valid replies and what was said. */
export async function runBench(
  provider: BenchProvider,
  models: string[],
  npc: NpcCard,
  onRow: (row: BenchRow) => void,
  timeoutMs = 20_000,
): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const model of models) {
    const row: BenchRow = { model, times: [], valid: 0, errors: [], samples: [] };
    const recent: string[] = [];
    for (const line of BENCH_LINES) {
      const prompt = buildPrompt({
        npcId: 'bench',
        npc,
        player: { id: 0, name: 'Shane' },
        memory: { notes: [], summary: '' },
        room: { title: 'Tilly\'s Curios', others: [] },
        recent: [...recent],
        playerLine: line,
        kind: 'say',
        allowedActions: ['none'],
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await provider.chat({ system: prompt.system, user: prompt.user, maxTokens: 150, json: true }, ctrl.signal, model);
        row.times.push(Date.now() - started);
        const reply = parseReply(res.text, ['none']);
        if (reply) {
          row.valid++;
          const said = [reply.emote ? `(${reply.emote})` : '', reply.say ? `"${reply.say}"` : ''].filter(Boolean).join(' ');
          row.samples.push(said);
          recent.push(`Shane: ${line}`, `${npc.name}: ${reply.say}`);
        } else {
          row.samples.push(`[not usable: ${res.text.slice(0, 80) || 'empty'}]`);
        }
      } catch (err) {
        row.errors.push(ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.message.slice(0, 120) : String(err));
        if (!ctrl.signal.aborted && /40[0134]/.test(String(err))) break; // the model isn't available: skip the rest
      } finally {
        clearTimeout(timer);
      }
    }
    rows.push(row);
    onRow(row);
  }
  return rows;
}

export const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
