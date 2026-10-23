/** Counts open connections per IP, shared by the web and telnet doors. */
export class IpCounter {
  private open = new Map<string, number>();

  constructor(private max: number) {}

  /** Returns false when this IP already has too many connections. */
  acquire(ip: string): boolean {
    const n = this.open.get(ip) ?? 0;
    if (n >= this.max) return false;
    this.open.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = (this.open.get(ip) ?? 1) - 1;
    if (n <= 0) this.open.delete(ip);
    else this.open.set(ip, n);
  }
}

/**
 * Runs one connection's input lines in order, at most `perSecond` a second.
 * Extra lines are dropped and the player is told once.
 */
export class LineGate {
  private chain: Promise<unknown> = Promise.resolve();
  private second = 0;
  private count = 0;

  constructor(
    private perSecond: number,
    private onFlood: () => void,
  ) {}

  /** Queues work that should run in order but isn't rate limited (connect, disconnect). */
  run(fn: () => unknown): void {
    this.chain = this.chain.then(fn).catch((err) => console.error('connection task failed:', err));
  }

  /** Queues a typed line, unless the player is flooding. */
  line(fn: () => unknown, onError: () => void): void {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.second) {
      this.second = sec;
      this.count = 0;
    }
    if (++this.count > this.perSecond) {
      if (this.count === this.perSecond + 1) this.onFlood();
      return;
    }
    this.chain = this.chain.then(fn).catch((err) => {
      console.error('input failed:', err);
      onError();
    });
  }
}

export const FLOOD_MESSAGE = 'Slow down, the fog can only take so much at once.';
