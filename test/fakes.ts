import type { ChatProvider, ChatRequest, ChatResult } from '../src/ai/types.js';

/** A provider whose behaviour each test controls. */
export class FakeProvider implements ChatProvider {
  calls: ChatRequest[] = [];
  configured = true;

  constructor(
    public name: string,
    public handler: (req: ChatRequest, signal: AbortSignal) => Promise<string> | string,
    public timeoutMs = 300,
    public model = 'fake-model',
  ) {}

  isConfigured() {
    return this.configured;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    this.calls.push(req);
    const text = await this.handler(req, signal);
    return { text, tokensIn: 100, tokensOut: 20 };
  }
}

/** Never resolves until aborted, like a provider that hangs. */
export function hang(_req: ChatRequest, signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
}

export const reply = (say: string, action: object = { type: 'none' }, emote?: string) =>
  JSON.stringify({ say, ...(emote ? { emote } : {}), action });
