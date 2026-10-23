// AI provider types. Adapted from LetsMCP's adapter, trimmed for game chat:
// a system prompt plus one user message in, a short JSON reply out.

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  json: boolean;
}

export interface ChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ChatProvider {
  name: string;
  model: string;
  timeoutMs: number;
  isConfigured(): boolean;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
}
