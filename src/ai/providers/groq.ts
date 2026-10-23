import type { ChatProvider, ChatRequest, ChatResult } from '../types.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqProvider implements ChatProvider {
  name = 'groq';

  constructor(
    private apiKey: string,
    public model: string,
    public timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        temperature: 0.8,
        max_tokens: req.maxTokens,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }
}
