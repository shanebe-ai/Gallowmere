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

  constructor(providers: Array<{ provider: ChatProvider; rpm: number }>) {
    this.slots = providers.map((p) => ({ provider: p.provider, bucket: new RateBucket(p.rpm) }));
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
            continue;
          }
          attempts.push({ provider: provider.name, model: provider.model, ok: true, latencyMs });
          return { ...result, provider: provider.name, model: provider.model, latencyMs, attempts };
        } catch (err) {
          const latencyMs = Date.now() - started;
          const msg = ctrl.signal.aborted ? 'timeout' : err instanceof Error ? err.message : String(err);
          attempts.push({ provider: provider.name, model: provider.model, ok: false, error: msg, latencyMs });
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
