import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io } from 'socket.io-client';
import '@xterm/xterm/css/xterm.css';

const TOKEN_KEY = 'gm_token';
const SCREEN_KEY = 'gm_screen';
const SCREEN_MAX = 200_000; // characters of recent output kept across a reload
const HISTORY_KEY = 'gm_history';
const HISTORY_MAX = 100;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const termEl = $('term');
const form = $<HTMLFormElement>('input-row');
const input = $<HTMLInputElement>('cmd');
const promptEl = $('prompt');
const statusInfo = $('status-info');
const connEl = $('conn');
const exitsEl = $('exits');

const isPhone = window.matchMedia('(max-width: 600px)').matches;

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: run without storage */
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Some phones throw the page away while you're in another app and reload it when you come
// back. The recent screen is kept in this tab's session storage so it can be put back.
let screen = '';
let screenTimer: number | null = null;
let shown = false; // the terminal shows the game, so a reconnect needn't repeat the room

function keepScreen(text: string) {
  screen += text;
  if (screen.length > SCREEN_MAX * 1.25) screen = screen.slice(-SCREEN_MAX);
  if (screenTimer !== null) return;
  screenTimer = window.setTimeout(() => {
    screenTimer = null;
    try {
      sessionStorage.setItem(SCREEN_KEY, screen.slice(-SCREEN_MAX));
    } catch {
      /* storage full or blocked: the screen just won't survive a reload */
    }
  }, 1000);
}

function savedScreen(): string {
  try {
    return sessionStorage.getItem(SCREEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function forgetScreen() {
  screen = '';
  try {
    sessionStorage.removeItem(SCREEN_KEY);
  } catch {
    /* nothing to forget */
  }
}

const term = new Terminal({
  fontFamily: "VT323, 'IBM Plex Mono', monospace",
  fontSize: isPhone ? 18 : 21,
  lineHeight: 1.05,
  scrollback: 2000,
  convertEol: true,
  disableStdin: true,
  cursorBlink: false,
  cursorStyle: 'bar',
  cursorInactiveStyle: 'none',
  theme: {
    background: '#0a0f0a',
    foreground: '#33ff33',
    cursor: '#0a0f0a',
    selectionBackground: '#1a9933',
    black: '#0a0f0a',
    red: '#ff3333',
    green: '#33ff33',
    yellow: '#ffb000',
    blue: '#3366ff',
    magenta: '#ff66ff',
    cyan: '#33ffff',
    white: '#c8ffc8',
    brightBlack: '#1a9933',
    brightRed: '#ff6666',
    brightGreen: '#66ff66',
    brightYellow: '#ffc840',
    brightBlue: '#6699ff',
    brightMagenta: '#ff99ff',
    brightCyan: '#99ffff',
    brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);

// Exit names on an "Exits:" line become clickable.
const LIST_RE = /^(People: +|Players: +|You see: +)/;
const lineAt = (y: number) => term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';

/** True when row y is part of a People, Players or You see list (continuation rows are indented). */
function inList(y: number): boolean {
  for (let row = y; row > 0 && y - row < 12; row--) {
    const line = lineAt(row);
    if (LIST_RE.test(line)) return true;
    if (!line.startsWith('         ')) return false;
  }
  return false;
}

term.registerLinkProvider({
  provideLinks(y, callback) {
    const line = lineAt(y);
    const links: ILink[] = [];
    if (line.startsWith('Exits:')) {
      // Exit names become clickable.
      const re = /\b(north|south|east|west|up|down)\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const dir = m[1];
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + dir.length, y } },
          text: dir,
          decorations: { underline: true, pointerCursor: true },
          activate: () => submit(dir),
        });
      }
    } else if (inList(y)) {
      // Each name in a list becomes clickable and looks at it.
      const start = line.match(LIST_RE)?.[0].length ?? 9;
      let x = start;
      for (const part of line.slice(start).split(', ')) {
        const name = part.replace(/,$/, '').trimEnd();
        const target = name.split(' ').pop() ?? '';
        if (target) {
          links.push({
            range: { start: { x: x + 1, y }, end: { x: x + name.length, y } },
            text: name,
            decorations: { underline: true, pointerCursor: true },
            activate: () => submit(`look ${target.toLowerCase()}`),
          });
        }
        x += part.length + 2;
      }
    }
    callback(links.length ? links : undefined);
  },
});

// ------------------------------------------------------------------ socket

const socket = io({ transports: ['websocket', 'polling'] });
let echo = true;

function setConn(state: 'ok' | 'wait' | 'down', label: string) {
  connEl.className = `conn conn-${state}`;
  connEl.textContent = label;
  connEl.title = label;
}

// The terminal is measured before saying hello, so the server wraps to the real width.
let markReady: () => void = () => undefined;
const ready = new Promise<void>((r) => (markReady = r));

socket.on('connect', async () => {
  setConn('ok', 'online');
  await ready;
  lastCols = term.cols;
  const token = load(TOKEN_KEY);
  socket.emit('hello', { token, cols: term.cols, keepScreen: shown && !!token });
});

socket.on('disconnect', () => {
  setConn('wait', 'reconnecting');
  exitsEl.replaceChildren();
});

socket.io.on('reconnect_failed', () => setConn('down', 'offline'));

socket.on('out', (text: string) => {
  term.write(text);
  keepScreen(text);
});

socket.on('mode', (mode: { echo: boolean; prompt: string }) => {
  echo = mode.echo;
  input.type = mode.echo ? 'text' : 'password';
  promptEl.textContent = mode.prompt;
  input.value = '';
});

socket.on('session', (token: string | null) => {
  store(TOKEN_KEY, token);
  if (token) shown = true;
  if (!token) {
    shown = false;
    statusInfo.replaceChildren();
    exitsEl.replaceChildren();
  }
});

socket.on('status', (s: { name: string; room: string; online: number; exits: string[]; coin?: number; health?: number; maxHealth?: number }) => {
  const name = document.createElement('b');
  name.textContent = s.name;
  const parts: Node[] = [name];
  if (typeof s.health === 'number' && typeof s.maxHealth === 'number') {
    // Health turns amber when hurt and red when the cart would take you.
    const hp = document.createElement('span');
    const f = s.health / s.maxHealth;
    hp.className = f < 1 / 3 ? 'hp hp-low' : f < 0.75 ? 'hp hp-mid' : 'hp';
    hp.textContent = `${s.health}/${s.maxHealth}`;
    parts.push(document.createTextNode(' · '), hp);
  }
  const coin = typeof s.coin === 'number' ? ` · ${s.coin} coin` : '';
  parts.push(document.createTextNode(`${coin} · ${s.room} · ${s.online} online`));
  statusInfo.replaceChildren(...parts);
  renderExits(s.exits);
});

function renderExits(exits: string[]) {
  const buttons = [...exits, 'look'].map((dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = dir;
    b.addEventListener('click', () => {
      submit(dir);
      if (!isPhone) input.focus();
    });
    return b;
  });
  exitsEl.replaceChildren(...(exits.length ? buttons : []));
  fitTerm();
}

// ------------------------------------------------------------------ input

let history: string[] = [];
try {
  history = JSON.parse(load(HISTORY_KEY) ?? '[]');
  if (!Array.isArray(history)) history = [];
} catch {
  history = [];
}
let histPos = history.length;
let draft = '';

function submit(line: string) {
  if (!socket.connected) {
    term.write('\x1b[33m[Not connected. Retrying...]\x1b[0m\n');
    return;
  }
  if (echo) {
    term.write(`\x1b[2m> ${line}\x1b[0m\n`);
    keepScreen(`\x1b[2m> ${line}\x1b[0m\n`);
    if (line.trim() && history[history.length - 1] !== line) {
      history.push(line);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      store(HISTORY_KEY, JSON.stringify(history));
    }
  }
  histPos = history.length;
  draft = '';
  socket.emit('line', line);
  term.scrollToBottom();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const line = input.value;
  input.value = '';
  submit(line);
});

input.addEventListener('keydown', (e) => {
  if (!echo) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (histPos === history.length) draft = input.value;
    if (histPos > 0) input.value = history[--histPos];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (histPos < history.length - 1) input.value = history[++histPos];
    else {
      histPos = history.length;
      input.value = draft;
    }
  } else if (e.key === 'PageUp') {
    e.preventDefault();
    term.scrollPages(-1);
  } else if (e.key === 'PageDown') {
    e.preventDefault();
    term.scrollPages(1);
  }
});

// Touch scrolling: the terminal doesn't scroll on a swipe by itself, so swipes are turned into
// line scrolls here, with a little momentum on a flick. Captured before the terminal sees them.
let touchY: number | null = null;
let carry = 0; // pixels moved but not yet a whole line
let velocity = 0; // pixels per millisecond, for the flick
let lastMove = 0;
let glide: number | null = null;

function rowHeight(): number {
  const row = termEl.querySelector('.xterm-rows > div') as HTMLElement | null;
  return row?.getBoundingClientRect().height || 20;
}

function scrollByPixels(dy: number) {
  carry += dy;
  const h = rowHeight();
  const lines = Math.trunc(carry / h);
  if (lines) {
    term.scrollLines(-lines);
    carry -= lines * h;
  }
}

function stopGlide() {
  if (glide !== null) cancelAnimationFrame(glide);
  glide = null;
}

termEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    stopGlide();
    touchY = e.touches[0].clientY;
    carry = 0;
    velocity = 0;
    lastMove = performance.now();
  },
  { passive: true, capture: true },
);

termEl.addEventListener(
  'touchmove',
  (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - touchY;
    const now = performance.now();
    velocity = dy / Math.max(1, now - lastMove);
    lastMove = now;
    touchY = y;
    scrollByPixels(dy);
    e.preventDefault();
    e.stopPropagation();
  },
  { passive: false, capture: true },
);

termEl.addEventListener(
  'touchend',
  () => {
    if (touchY === null) return;
    touchY = null;
    // A flick keeps going and slows down, like any phone page.
    let v = velocity;
    let last = performance.now();
    const step = (t: number) => {
      const dt = t - last;
      last = t;
      v *= Math.pow(0.95, dt / 16);
      if (Math.abs(v) < 0.05) return stopGlide();
      scrollByPixels(v * dt);
      glide = requestAnimationFrame(step);
    };
    if (Math.abs(v) > 0.2) glide = requestAnimationFrame(step);
  },
  { passive: true, capture: true },
);

// Clicking the output puts focus back in the input, unless text is being selected.
termEl.addEventListener('mouseup', () => {
  if (!term.hasSelection() && !isPhone) input.focus();
});

// ------------------------------------------------------------------ sizing

let lastCols = 0;
function fitTerm() {
  try {
    fit.fit();
  } catch {
    return;
  }
  if (term.cols !== lastCols) {
    lastCols = term.cols;
    if (socket.connected) socket.emit('size', term.cols);
  }
}

// Keep the input above the on screen keyboard on phones.
let lastHeight = 0;
function fitViewport() {
  const vv = window.visualViewport;
  const app = $('app');
  const buf = term.buffer.active;
  // Only follow the bottom if the player was already there; scrolling back to read stays put.
  const atBottom = buf.viewportY >= buf.baseY;
  const height = vv ? vv.height : window.innerHeight;
  // The address bar sliding away while scrolling nudges the height a little; the keyboard opening is a big drop.
  const keyboardOpened = lastHeight > 0 && lastHeight - height > 120;
  lastHeight = height;
  if (vv) {
    app.style.height = `${vv.height}px`;
    app.style.top = `${vv.offsetTop}px`;
  }
  fitTerm();
  if (atBottom || keyboardOpened) term.scrollToBottom();
}

window.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);

async function start() {
  // Wait for the terminal font so character cells measure correctly.
  try {
    await Promise.race([document.fonts.load('21px VT323'), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* fall back to whatever font is available */
  }
  term.open(termEl);
  // Back from a reload: put the old screen back, so history and scrolling survive.
  const old = savedScreen();
  if (old && load(TOKEN_KEY)) {
    screen = old;
    term.write(old);
    shown = true;
  } else if (old) {
    forgetScreen();
  }
  fitViewport();
  markReady();
  input.focus();
}

void start();

