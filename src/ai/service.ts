import type { ChatProvider, ChatRequest, ChatResult } from './types.js';

/** Token bucket: refills to `perMinute` tokens spread evenly over a minute. */
export class RateBucket {
  private tokens: number;
  private last: number;

  constructor(
    private perMinute: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60000) * this.perMinute);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
}

export interface ServiceResult extends ChatResult {
  provider: string;
  model: string;
  latencyMs: number;
  attempts: Attempt[];
}

interface Slot {
  provider: ChatProvider;
  bucket: RateBucket;
}

/**
 * Tries providers in order (ai&, then Groq, then Gemini). Each has its own rate bucket and
 * timeout. Throws when every provider is unavailable, so the caller can fall
 * back to scripted lines.
 */
export class AIService {
  private slots: Slot[];
  /** The last thing that happened with each provider, for the admin. */
  private last = new Map<string, { ok: boolean; at: number; error?: string; latencyMs: number }>();

  constructor(providers: Array<{ provider: ChatProvider; rpm: number }>) {
    this.slots = providers.map((p) => ({ provider: p.provider, bucket: new RateBucket(p.rpm) }));
  }

  /** Each provider in order: whether it has a key, and how its last call went. */
  status(): Array<{ name: string; model: string; configured: boolean; last?: { ok: boolean; at: number; error?: string; latencyMs: number } }> {
    return this.slots.map(({ provider }) => ({
      name: provider.name,
      model: provider.model,
      configured: provider.isConfigured(),
      last: this.last.get(provider.name),
    }));
  }

  private note(a: Attempt): void {
    this.last.set(a.provider, { ok: a.ok, at: Date.now(), error: a.error, latencyMs: a.latencyMs });
  }

  /** Sends one tiny request to every provider that has a key, so the admin can see which work. */
  async ping(): Promise<Array<{ name: string; model: string; configured: boolean; ok?: boolean; latencyMs?: number; error?: string }>> {
    const req = { system: 'Reply only with the JSON object {"ok": true}.', user: 'ping', maxTokens: 20, json: true };
    return Promise.all(
      this.slots.map(async ({ provider }) => {
        const base = { name: provider.name, model: provider.model, configured: provider.isConfigured() };
        if (!base.configured) return base;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(provider.timeoutMs, 10_000));
        const started = Date.now();
        try {
          const res = await provider.chat(req, ctrl.signal);
          const latencyMs = Date.now() - started;
          return res.text ? { ...base, ok: true, latencyMs } : { ...base, ok: false, latencyMs, error: 'empty reply' };
        } catch (err) {
          const error = ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.message.slice(0, 200) : String(err);
          return { ...base, ok: false, latencyMs: Date.now() - started, error };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  hasProvider(): boolean {
    return this.slots.some((s) => s.provider.isConfigured());
  }

  async chat(req: ChatRequest, validate: (text: string) => boolean = () => true): Promise<ServiceResult> {
    const attempts: Attempt[] = [];
    for (const { provider, bucket } of this.slots) {
      if (!provider.isConfigured()) continue;
      if (!bucket.take()) {
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: 'rate guard', latencyMs: 0 });
        this.note(attempts[attempts.length - 1]);
        continue;
      }
      // One retry on a reply that fails validation, then move on.
      for (let tries = 0; tries < 2; tries++) {
        const started = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), provider.timeoutMs);
        try {
          const result = await provider.chat(req, ctrl.signal);
          const latencyMs = Date.now() - started;
          if (!validate(result.text)) {
            attempts.push({ provider: provider.name, model: provider.model, ok: false, error: 'invalid reply', latencyMs });
            this.note(attempts[attempts.length - 1]);
            continue;
          }
          attempts.push({ provider: provider.name, model: provider.model, ok: true, latencyMs });
          this.note(attempts[attempts.length - 1]);
          return { ...result, provider: provider.name, model: provider.model, latencyMs, attempts };
        } catch (err) {
          const latencyMs = Date.now() - started;
          const msg = ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.message : String(err);
          attempts.push({ provider: provider.name, model: provider.model, ok: false, error: msg, latencyMs });
          this.note(attempts[attempts.length - 1]);
          break; // network or API errors go straight to the next provider
        } finally {
          clearTimeout(timer);
        }
      }
    }
    const err = new Error('All AI providers unavailable') as Error & { attempts: Attempt[] };
    err.attempts = attempts;
    throw err;
  }
}
