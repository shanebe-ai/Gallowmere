import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiandProvider } from '../src/ai/providers/aiand.js';

const req = { system: 'sys', user: 'usr', maxTokens: 150, json: true };
const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('ai& provider', () => {
  it('posts an OpenAI style chat to ai& with the key, JSON mode and thinking off', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return ok('{"say":"Hello, dearie."}');
    });
    const p = new AiandProvider('k123', 'deepseek-ai/deepseek-v4-flash', 5000);
    const res = await p.chat(req, new AbortController().signal);
    expect(res).toEqual({ text: '{"say":"Hello, dearie."}', tokensIn: 50, tokensOut: 10 });
    expect(calls[0].url).toBe('https://api.aiand.com/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k123');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      model: 'deepseek-ai/deepseek-v4-flash',
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
    });
  });

  it('steps the thinking setting down for models that refuse it, and remembers what worked', async () => {
    const efforts: Array<string | undefined> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      efforts.push(body.reasoning_effort);
      if (body.reasoning_effort === 'none') return new Response('{"error":"reasoning_effort none not supported"}', { status: 400 });
      return ok('{"say":"Fine."}');
    });
    const p = new AiandProvider('k', 'openai/gpt-oss-120b', 5000);
    await p.chat(req, new AbortController().signal);
    await p.chat(req, new AbortController().signal);
    expect(efforts).toEqual(['none', 'low', 'low']);
  });

  it('drops thinking out loud and reports API errors plainly', async () => {
    vi.stubGlobal('fetch', async () => ok('<think>she wants {coin}</think>{"say":"Two coppers."}'));
    const p = new AiandProvider('k', 'm', 5000);
    expect((await p.chat(req, new AbortController().signal)).text).toBe('{"say":"Two coppers."}');
    vi.stubGlobal('fetch', async () => new Response('bad key', { status: 401 }));
    await expect(p.chat(req, new AbortController().signal)).rejects.toThrow('aiand API error 401: bad key');
  });

  it('is off without a key, and lists the models a key can use', async () => {
    expect(new AiandProvider('', 'm', 5000).isConfigured()).toBe(false);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{ id: 'z/b' }, { id: 'a/c' }] }), { status: 200 }));
    expect(await new AiandProvider('k', 'm', 5000).models(new AbortController().signal)).toEqual(['a/c', 'z/b']);
  });
});
