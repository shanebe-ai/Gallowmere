import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io } from 'socket.io-client';
import '@xterm/xterm/css/xterm.css';

const TOKEN_KEY = 'gm_token';
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
term.registerLinkProvider({
  provideLinks(y, callback) {
    const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
    if (!line.startsWith('Exits:')) return callback(undefined);
    const links: ILink[] = [];
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
    callback(links);
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
  socket.emit('hello', { token: load(TOKEN_KEY), cols: term.cols });
});

socket.on('disconnect', () => {
  setConn('wait', 'reconnecting');
  exitsEl.replaceChildren();
});

socket.io.on('reconnect_failed', () => setConn('down', 'offline'));

socket.on('out', (text: string) => term.write(text));

socket.on('mode', (mode: { echo: boolean; prompt: string }) => {
  echo = mode.echo;
  input.type = mode.echo ? 'text' : 'password';
  promptEl.textContent = mode.prompt;
  input.value = '';
});

socket.on('session', (token: string | null) => {
  store(TOKEN_KEY, token);
  if (!token) {
    statusInfo.replaceChildren();
    exitsEl.replaceChildren();
  }
});

socket.on('status', (s: { name: string; room: string; online: number; exits: string[] }) => {
  const name = document.createElement('b');
  name.textContent = s.name;
  statusInfo.replaceChildren(name, document.createTextNode(` · ${s.room} · ${s.online} online`));
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
function fitViewport() {
  const vv = window.visualViewport;
  const app = $('app');
  if (vv) {
    app.style.height = `${vv.height}px`;
    app.style.top = `${vv.offsetTop}px`;
  }
  fitTerm();
  term.scrollToBottom();
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
  fitViewport();
  markReady();
  input.focus();
}

void start();

