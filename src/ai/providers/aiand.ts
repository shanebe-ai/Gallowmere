import type { ChatProvider, ChatRequest, ChatResult } from '../types.js';

const AIAND_API = 'https://api.aiand.com/v1';

/**
 * ai& (aiand.com): open models behind an OpenAI compatible API.
 * Thinking models are asked not to think (reasoning_effort), since townsfolk need to answer quickly.
 * Models that don't accept that setting are remembered and asked without it.
 */
export class AiandProvider implements ChatProvider {
  name = 'aiand';
  /** The thinking setting each model accepted, once known ('' means it takes none). */
  private effortFor = new Map<string, string>();

  constructor(
    private apiKey: string,
    public model: string,
    public timeoutMs: number,
    private reasoningEffort = 'none',
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(req: ChatRequest, signal: AbortSignal, model = this.model): Promise<ChatResult> {
    // Try the configured setting, then the lightest a model may insist on, then none at all.
    const known = this.effortFor.get(model);
    const efforts = known !== undefined ? [known] : [...new Set([this.reasoningEffort, 'low', ''])];
    let res!: Response;
    for (const [i, effort] of efforts.entries()) {
      res = await this.post(req, signal, model, effort);
      if (res.status === 400 && effort && i < efforts.length - 1) {
        const body = await res.text();
        if (/reasoning/i.test(body)) continue;
        throw new Error(`aiand API error 400: ${body.slice(0, 200)}`);
      }
      if (res.ok) this.effortFor.set(model, effort);
      break;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`aiand API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Some models think out loud inside <think> tags; only the answer matters.
    const text = (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return {
      text,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }

  private post(req: ChatRequest, signal: AbortSignal, model: string, effort: string): Promise<Response> {
    return fetch(`${AIAND_API}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        temperature: 0.9,
        // Headroom for models that think a little before answering. Replies are still capped by the game.
        max_tokens: req.maxTokens * 4,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  }

  /** The models this key can use. */
  async models(signal: AbortSignal): Promise<string[]> {
    const res = await fetch(`${AIAND_API}/models`, { signal, headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`aiand API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id).sort();
  }
}
