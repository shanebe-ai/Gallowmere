import type { ChatProvider, ChatRequest, ChatResult } from '../types.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiProvider implements ChatProvider {
  name = 'gemini';

  constructor(
    private apiKey: string,
    public model: string,
    public timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    // Key goes in a header rather than the URL so it never lands in logs.
    const res = await fetch(`${GEMINI_API_URL}/${this.model}:generateContent`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: req.maxTokens,
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}
