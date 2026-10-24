import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqProvider } from '../src/ai/providers/groq.js';
import { GeminiProvider } from '../src/ai/providers/gemini.js';

const req = { system: 'sys', user: 'usr', maxTokens: 150, json: true };
afterEach(() => vi.unstubAllGlobals());

describe('Groq and Gemini on their current models', () => {
  it('asks gpt-oss on Groq to think lightly and leaves room for it', async () => {
    let body: any;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"Aye."}' } }] }), { status: 200 });
    });
    const out = await new GroqProvider('k', 'openai/gpt-oss-20b', 4000).chat(req, new AbortController().signal);
    expect(out.text).toBe('{"say":"Aye."}');
    expect(body).toMatchObject({ model: 'openai/gpt-oss-20b', reasoning_effort: 'low', max_tokens: 600 });
    await new GroqProvider('k', 'some-plain-model', 4000).chat(req, new AbortController().signal);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(150);
  });

  it('takes the answer from Gemini, not its thoughts', async () => {
    let url = '';
    vi.stubGlobal('fetch', async (u: string) => {
      url = u;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking about coin', thought: true }, { text: '{"say":"Two coppers."}' }] } }] }),
        { status: 200 },
      );
    });
    const out = await new GeminiProvider('k', 'gemini-3.5-flash-lite', 6000).chat(req, new AbortController().signal);
    expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(out.text).toBe('{"say":"Two coppers."}');
  });
});
