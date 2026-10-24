import { wrap } from './text.js';

/** Transport independent connection, so a telnet door can plug in later. */
export interface Connection {
  ip: string;
  send(text: string): void;
  setMode(mode: { echo: boolean; prompt: string }): void;
  setStatus(status: { name: string; room: string; online: number; exits: string[]; coin: number }): void;
  setToken(token: string | null): void;
  close(): void;
}

export type LoginState = 'name' | 'password' | 'confirmNew' | 'newPassword' | 'newPassword2' | 'playing' | 'closed';

export interface PlayerState {
  id: number;
  name: string;
  roomId: string;
  createdAt: Date;
}

export class Session {
  state: LoginState = 'name';
  cols = 80;
  player: PlayerState | null = null;
  aliases = new Map<string, string>();
  pendingName = '';
  firstPassword = '';
  wrongPasswords = 0;
  aiPending = false;
  /** The last thing this player looked at or handled, so "take it" works. */
  lastTarget: string | null = null;
  quitting = false;

  constructor(public conn: Connection) {}

  /** Sends text, word wrapped to the client's width, followed by a newline. */
  out(text: string): void {
    this.conn.send(wrap(text, this.cols) + '\n');
  }

  setCols(cols: number): void {
    if (Number.isFinite(cols)) this.cols = Math.max(30, Math.min(200, Math.floor(cols)));
  }
}
