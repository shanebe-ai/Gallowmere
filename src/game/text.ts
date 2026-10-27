// ANSI colours and text helpers for the terminal.

const ESC = '\x1b[';

export const c = {
  reset: `${ESC}0m`,
  title: (s: string) => `${ESC}1;33m${s}${ESC}0m`, // bright amber
  exits: (s: string) => `${ESC}36m${s}${ESC}0m`, // cyan
  player: (s: string) => `${ESC}1;37m${s}${ESC}0m`, // bright white
  npc: (s: string) => `${ESC}1;32m${s}${ESC}0m`, // bright green
  label: (s: string) => `${ESC}2;37m${s}${ESC}0m`, // dim grey
  thing: (s: string) => `${ESC}33m${s}${ESC}0m`, // amber
  speech: (s: string) => `${ESC}1;35m${s}${ESC}0m`, // magenta
  dim: (s: string) => `${ESC}2m${s}${ESC}0m`,
  error: (s: string) => `${ESC}31m${s}${ESC}0m`, // red
  system: (s: string) => `${ESC}33m${s}${ESC}0m`, // amber
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Removes escape codes and control characters from untrusted text (players or AI). */
export function sanitize(input: string, maxLen: number): string {
  let s = String(input ?? '').replace(ANSI_RE, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd();
  return s;
}

/** Word wraps text to a column width, counting only visible characters. Keeps existing newlines. */
export function wrap(text: string, cols: number): string {
  const width = Math.max(20, cols - 1);
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

function wrapLine(line: string, width: number): string {
  if (stripAnsi(line).length <= width) return line;
  const words = line.split(' ');
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const w of words) {
    const wl = stripAnsi(w).length;
    if (curLen === 0) {
      cur = w;
      curLen = wl;
    } else if (curLen + 1 + wl <= width) {
      cur += ' ' + w;
      curLen += 1 + wl;
    } else {
      out.push(cur);
      cur = w;
      curLen = wl;
    }
  }
  if (cur) out.push(cur);
  return out.join('\n');
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The key a character name is filed under: lower case with the accents stripped, so Noelle and Noëlle are the same name. */
export function nameKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
