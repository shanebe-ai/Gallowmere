import net from 'node:net';
import type { Game } from '../game/game.js';
import type { Connection } from '../game/session.js';
import { FLOOD_MESSAGE, IpCounter, LineGate } from './limits.js';

// Telnet protocol bytes (RFC 854 and friends).
export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const GA = 249;
export const SE = 240;
export const ECHO = 1;
export const SGA = 3;
export const NAWS = 31;

const MAX_LINE = 1000;
const IDLE_MS = 60 * 60_000;

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const LATIN1 = new TextDecoder('windows-1252');

/**
 * Turns a line of raw bytes into text. Modern clients send UTF-8; older ones
 * send Latin-1, where an accented letter is a single byte that is not valid
 * UTF-8 on its own. Try strict UTF-8 first and fall back, so names and words
 * with accents arrive whole from either kind of client.
 */
export function decodeLine(bytes: Buffer): string {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return LATIN1.decode(bytes);
  }
}

/**
 * Strips telnet commands out of incoming bytes and turns the rest into lines.
 * Handles NAWS (window size) so text wraps to the client's width.
 */
export class TelnetParser {
  private state: 'data' | 'iac' | 'cmd' | 'sb' | 'sb_iac' = 'data';
  private sb: number[] = [];
  private buf: number[] = [];
  private lastWasCR = false;
  overflowed = false;

  constructor(
    private onLine: (line: string) => void,
    private onCols: (cols: number) => void,
    private onCommand: (cmd: number, opt: number) => void = () => undefined,
  ) {}

  private cmd = 0;

  push(chunk: Buffer): void {
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else this.data(b);
          break;
        case 'iac':
          if (b === IAC) {
            this.data(IAC);
            this.state = 'data';
          } else if (b === SB) {
            this.sb = [];
            this.state = 'sb';
          } else if (b === WILL || b === WONT || b === DO || b === DONT) {
            this.cmd = b;
            this.state = 'cmd';
          } else {
            this.state = 'data'; // GA, NOP, AYT and the rest: ignored
          }
          break;
        case 'cmd':
          this.onCommand(this.cmd, b);
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb_iac';
          else if (this.sb.length < 64) this.sb.push(b);
          break;
        case 'sb_iac':
          if (b === SE) {
            this.subnegotiation();
            this.state = 'data';
          } else {
            if (this.sb.length < 64) this.sb.push(b); // IAC IAC inside SB is a literal 255
            this.state = 'sb';
          }
          break;
      }
    }
  }

  private subnegotiation(): void {
    if (this.sb[0] === NAWS && this.sb.length >= 5) {
      const cols = (this.sb[1] << 8) | this.sb[2];
      if (cols > 0) this.onCols(cols);
    }
  }

  private data(b: number): void {
    if (b === 13) {
      this.flush();
      this.lastWasCR = true;
      return;
    }
    if (b === 10) {
      if (!this.lastWasCR) this.flush();
      this.lastWasCR = false;
      return;
    }
    this.lastWasCR = false;
    if (b === 0) return; // CR NUL
    if (b === 8 || b === 127) {
      this.buf.pop(); // backspace from clients in character mode
      return;
    }
    if (this.buf.length >= MAX_LINE) {
      this.overflowed = true;
      return;
    }
    this.buf.push(b);
  }

  private flush(): void {
    const line = decodeLine(Buffer.from(this.buf));
    this.buf = [];
    this.overflowed = false;
    this.onLine(line);
  }
}

/** Plain telnet door into the same game the browser uses. */
export function startTelnet(game: Game, port: number, ips: IpCounter): net.Server {
  const server = net.createServer((socket) => {
    const ip = (socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (!ips.acquire(ip)) {
      socket.end('Too many connections from your address.\r\n');
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(IDLE_MS);

    let prompt = '';
    let promptTimer: NodeJS.Immediate | null = null;
    let closed = false;

    const write = (data: string | Buffer) => {
      if (!closed && !socket.destroyed) socket.write(data);
    };

    // Prompt goes out once after each burst of output, like a classic MUD.
    const schedulePrompt = () => {
      if (promptTimer || !prompt) return;
      promptTimer = setImmediate(() => {
        promptTimer = null;
        write(Buffer.concat([Buffer.from(prompt, 'utf8'), Buffer.from([IAC, GA])]));
      });
    };

    const conn: Connection = {
      ip,
      send(text) {
        write(text.replace(/\r?\n/g, '\r\n'));
        schedulePrompt();
      },
      setMode(mode) {
        // WILL ECHO with no echo back hides what is typed (passwords). WONT ECHO hands echo back to the client.
        write(Buffer.from([IAC, mode.echo ? WONT : WILL, ECHO]));
        if (!mode.echo) write('\r\n');
        prompt = mode.prompt;
        schedulePrompt();
      },
      setStatus() {
        // Browser only.
      },
      setToken() {
        // Browser only: telnet sessions don't resume.
      },
      close() {
        setTimeout(() => socket.end(), 50);
      },
    };

    let session: Awaited<ReturnType<Game['connect']>> | null = null;
    const gate = new LineGate(10, () => conn.send(FLOOD_MESSAGE));
    let cols = 80;

    const parser = new TelnetParser(
      (line) => {
        if (session?.state === 'password' || session?.state === 'newPassword' || session?.state === 'newPassword2') write('\r\n');
        gate.line(
          () => session && game.input(session, line),
          () => session?.out('Something went wrong in the fog. Try that again.'),
        );
      },
      (c) => {
        cols = c;
        session?.setCols(c);
      },
    );

    socket.on('data', (chunk: Buffer) => parser.push(chunk));
    socket.on('timeout', () => {
      conn.send('Idle too long. The fog takes you.');
      socket.end();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      closed = true;
      if (promptTimer) clearImmediate(promptTimer);
      ips.release(ip);
      gate.run(() => session && game.disconnect(session));
    });

    // Ask for the window size, keep it simple otherwise.
    write(Buffer.from([IAC, DO, NAWS, IAC, WILL, SGA]));
    // Give NAWS a moment to arrive so the banner wraps right.
    setTimeout(() => {
      if (closed) return;
      gate.run(async () => {
        session = await game.connect(conn, null, cols);
      });
    }, 250);
  });

  server.on('error', (err) => console.error('telnet server error:', err));
  server.listen(port, () => {
    const addr = server.address();
    console.log(`Gallowmere telnet on port ${typeof addr === 'object' && addr ? addr.port : port}`);
  });
  return server;
}
