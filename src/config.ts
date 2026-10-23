import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 3004),
  telnetPort: num('TELNET_PORT', 4004),
  maxConnectionsPerIp: num('MAX_CONNECTIONS_PER_IP', 8),
  newCharsPerHour: num('NEW_CHARS_PER_HOUR', 3),
  isProd: process.env.NODE_ENV === 'production',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num('DB_PORT', 5432),
    database: process.env.DB_NAME || 'gallowmere',
    user: process.env.DB_USER || 'gallowmere',
    password: process.env.DB_PASSWORD || '',
  },
  ai: {
    groqKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    geminiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    dailyCapPerPlayer: num('AI_DAILY_CAP_PER_PLAYER', 200),
    globalDailyCap: num('AI_DAILY_CAP_GLOBAL', 5000),
    groqRpm: num('GROQ_RPM', 25),
    geminiRpm: num('GEMINI_RPM', 12),
    groqTimeoutMs: num('GROQ_TIMEOUT_MS', 4000),
    geminiTimeoutMs: num('GEMINI_TIMEOUT_MS', 6000),
    maxOutputTokens: 150,
  },
  /** Player ids allowed to use admin commands. Player 1 is the first character ever created. */
  adminIds: (process.env.ADMIN_PLAYER_IDS || '1')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
};
