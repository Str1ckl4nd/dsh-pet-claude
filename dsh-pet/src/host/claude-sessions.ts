/**
 * dsh-pet-claude — Claude Code session source (standalone mode only).
 *
 * Standalone mode has no DeepSeek Harness session stream to feed the work-status
 * pipeline. This module feeds it from Claude Code instead. Claude Code keeps a
 * state file for every running process at ~/.claude/sessions/<pid>.json with
 * the session's title (`name`), its live status (busy | shell | idle | waiting)
 * and the desktop app's id for it (`hostSessionId`). Status counts background
 * subagents as busy, so idle means the work is really over. Nothing has to be
 * installed into the sessions themselves, and sessions already running when the
 * pet starts are covered.
 *
 * Two outputs, each called only when it changed:
 *   - onCards:     the session board for the panel (sections.claudeSessions)
 *   - onAggregate: one state + headline for the pet (sections.workStatus), which
 *                  the renderer animates through its native work-status path.
 *
 * "Read": a finished session stays on the board until you go to it after it
 * finished — pick it in the desktop app's sidebar (its lastFocusedAt moves), or
 * come back to the Claude window with it open (Windows: fgwatch reports the
 * foreground process). Having it open at the moment it finishes does not count.
 *
 * Self-contained (no src/shared imports), like the rest of src/host.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ClaudeMood = 'working' | 'waiting' | 'success';
export type ClaudeLang = 'zh' | 'en';

/** One row of the session panel. */
export interface ClaudeSessionCard {
  name: string;
  detail: string;
  mood: ClaudeMood;
  /** This particular finish; lets the panel dismiss it and still show the session's next one. */
  doneAt: number | null;
  /** The desktop app's own deep link for the session — the format it reports as a session's link. */
  link: string;
}

/** What the pet itself shows: the work-status state and the bubble text. */
export interface ClaudeAggregate {
  state: ClaudeMood | null;
  task: string | null;
}

export interface ClaudeBoard {
  cards: ClaudeSessionCard[];
  aggregate: ClaudeAggregate;
}

/** A native session file, reduced to the fields used and validated. */
export interface ClaudeSession {
  pid: number;
  sessionId: string;
  name: string;
  status: string;
  statusUpdatedAt: number;
  hostSessionId: string;
  interactive: boolean;
}

export const CLAUDE_LABELS: Record<ClaudeLang, Record<ClaudeMood, string>> = {
  zh: { working: '正在工作', waiting: '需要审批', success: '已经完成' },
  en: { working: 'Working', waiting: 'Needs approval', success: 'Done' },
};

const MOOD: Record<string, ClaudeMood> = { busy: 'working', shell: 'working', waiting: 'waiting', idle: 'success' };
const RANK: Record<ClaudeMood, number> = { waiting: 3, working: 2, success: 1 };

/** A short settle on a fresh idle keeps a between-turns blink off the panel. */
export const SETTLE_MS = 3000;
/** How long a fresh finish leads the pet before the busiest state takes over again. */
export const CHEER_MS = 6000;

/** Validate one parsed session file. Anything unusable is null, never thrown. */
export function parseSession(raw: unknown): ClaudeSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const sessionId = str(r.sessionId);
  const pid = num(r.pid);
  if (!sessionId || pid <= 0) return null;
  const folder = str(r.cwd).split(/[\\/]/).filter(Boolean).pop() ?? '';
  return {
    pid,
    sessionId,
    name: str(r.name) || folder || 'session',
    status: str(r.status),
    statusUpdatedAt: num(r.statusUpdatedAt),
    hostSessionId: str(r.hostSessionId),
    interactive: r.kind === 'interactive',
  };
}

/** What buildBoard remembers between ticks. */
export interface BoardMemory {
  /** sessionId → when it was first seen idle */
  idleSince: Map<string, number>;
  /** sessionId → when its finish first reached the board */
  shownDone: Map<string, number>;
}

export function newBoardMemory(): BoardMemory {
  return { idleSince: new Map(), shownDone: new Map() };
}

export interface BoardInputs {
  now: number;
  lang: ClaudeLang;
  /** The desktop app's lastFocusedAt for a session (0 when unknown). */
  focusedAt: (hostSessionId: string) => number;
  /** When you last came back to a session in the Claude window (0 when never). */
  arrivedAt: (hostSessionId: string) => number;
}

/**
 * Pure: the board and the pet's aggregate from the live sessions.
 * Only sessions the desktop app hosts are listed — they are the ones in its
 * sidebar, and the only ones a row can jump to. Headless and helper processes
 * register a session file too, for the moment they live.
 */
export function buildBoard(sessions: ClaudeSession[], memory: BoardMemory, inp: BoardInputs): ClaudeBoard {
  const label = CLAUDE_LABELS[inp.lang];
  const rows: { card: ClaudeSessionCard; shownAt: number | null }[] = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (!s.interactive || !s.hostSessionId) continue;
    seen.add(s.sessionId);
    let mood: ClaudeMood = MOOD[s.status] ?? 'working';
    let doneAt: number | null = null;

    if (mood === 'success') {
      const since = memory.idleSince.get(s.sessionId) ?? inp.now;
      memory.idleSince.set(s.sessionId, since);
      doneAt = s.statusUpdatedAt || since;
      // Read: you went to it after it finished.
      if (inp.focusedAt(s.hostSessionId) >= doneAt || inp.arrivedAt(s.hostSessionId) > doneAt) continue;
      if (inp.now - since < SETTLE_MS) {
        mood = 'working';
        doneAt = null;
      }
    } else {
      memory.idleSince.delete(s.sessionId);
    }

    let shownAt: number | null = null;
    if (mood === 'success') {
      shownAt = memory.shownDone.get(s.sessionId) ?? inp.now;
      memory.shownDone.set(s.sessionId, shownAt);
    } else {
      memory.shownDone.delete(s.sessionId);
    }

    rows.push({
      card: {
        name: s.name,
        detail: label[mood],
        mood,
        doneAt,
        link: 'claude://claude.ai/epitaxy/' + s.hostSessionId,
      },
      shownAt,
    });
  }

  // Sessions that are gone take their memory with them.
  for (const id of [...memory.idleSince.keys()]) if (!seen.has(id)) memory.idleSince.delete(id);
  for (const id of [...memory.shownDone.keys()]) if (!seen.has(id)) memory.shownDone.delete(id);

  rows.sort((a, b) => RANK[b.card.mood] - RANK[a.card.mood]);

  let aggregate: ClaudeAggregate = { state: null, task: null };
  const first = rows[0];
  if (first) {
    // A fresh finish leads for a few seconds, then the busiest state takes over
    // again. An approval request still outranks it: that one blocks work.
    const fresh = rows.find((r) => r.card.mood === 'success' && r.shownAt !== null && inp.now - r.shownAt < CHEER_MS);
    const lead = first.card.mood !== 'waiting' && fresh ? fresh.card : first.card;
    aggregate = { state: lead.mood, task: lead.name + ': ' + lead.detail };
  }

  return { cards: rows.map((r) => r.card), aggregate };
}

/** zh or en: DSH_PET_CLAUDE_LANG if set, otherwise the system locale. */
export function defaultLang(): ClaudeLang {
  const env = (process.env.DSH_PET_CLAUDE_LANG ?? '').toLowerCase();
  if (env === 'zh' || env === 'en') return env;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

/** Where the desktop app keeps its per-session files (read receipts). */
function appStoreDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  return join(homedir(), '.config', 'Claude', 'claude-code-sessions');
}

/** A crashed session leaves its file behind. Signal 0 tests the pid; EPERM still means alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readJson(file: string): unknown {
  // A session file is rewritten often; a read can land mid-write. Retry once.
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch {
      // try again
    }
  }
  return null;
}

function readSessions(dir: string): ClaudeSession[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ClaudeSession[] = [];
  for (const f of files) {
    const s = parseSession(readJson(join(dir, f)));
    if (s && isAlive(s.pid)) out.push(s);
  }
  return out;
}

/**
 * The desktop app's read receipts. lastFocusedAt is stamped when you pick a
 * session in the sidebar; the session open right now is the newest stamp.
 */
function createAppStore(root: string): { focusedAt: (hostId: string) => number; current: () => string | null } {
  const stamps = new Map<string, number>();
  let scannedAt = 0;
  let newest: string | null = null;

  const scan = (): void => {
    const now = Date.now();
    if (now - scannedAt < 1500) return;
    scannedAt = now;
    let best = 0;
    newest = null;
    try {
      for (const a of readdirSync(root, { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        for (const i of readdirSync(join(root, a.name), { withFileTypes: true })) {
          if (!i.isDirectory()) continue;
          const dir = join(root, a.name, i.name);
          for (const f of readdirSync(dir)) {
            if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
            let text = '';
            try {
              text = readFileSync(join(dir, f), 'utf8');
            } catch {
              continue;
            }
            const m = /"lastFocusedAt"\s*:\s*(\d+)/.exec(text);
            const v = m ? Number(m[1]) : 0;
            const id = f.slice(0, -5);
            stamps.set(id, v);
            if (v > best) {
              best = v;
              newest = id;
            }
          }
        }
      }
    } catch {
      // No desktop app store on this machine: no read receipts, everything else still works.
    }
  };

  return {
    focusedAt: (hostId) => {
      scan();
      return stamps.get(hostId) ?? 0;
    },
    current: () => {
      scan();
      return newest;
    },
  };
}

/**
 * fgwatch.exe (Windows): reports the foreground process — once at start, then
 * only on change — by subscribing to the OS foreground-change event and
 * sleeping otherwise. Built here on first use from src/host/fgwatch.cs with the
 * C# compiler that ships with Windows; nothing is downloaded.
 */
function buildFgwatch(userRoot: string, packageRoot: string, log: (m: string) => void): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const src = join(packageRoot, 'src', 'host', 'fgwatch.cs');
  const exe = join(userRoot, 'fgwatch.exe');
  if (!existsSync(src)) return Promise.resolve(null);
  try {
    if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(src).mtimeMs) return Promise.resolve(exe);
  } catch {
    // fall through and rebuild
  }
  const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(csc)) {
    log('claude: C# compiler not found; coming back to a session will not mark it read');
    return Promise.resolve(null);
  }
  try {
    mkdirSync(userRoot, { recursive: true });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(csc, ['-nologo', '-target:exe', '-optimize+', '-out:' + exe, src], { windowsHide: true }, (err) => {
      if (err) {
        log('claude: building fgwatch failed: ' + err.message);
        resolve(null);
      } else {
        resolve(exe);
      }
    });
  });
}

export interface ClaudeSessionsOptions {
  /** dsh-pet's user directory (~/.dsh/dsh-pet): where fgwatch.exe is built. */
  userRoot: string;
  /** The package root: where src/host/fgwatch.cs ships. */
  packageRoot: string;
  lang: ClaudeLang;
  log: (message: string) => void;
  onCards: (cards: ClaudeSessionCard[]) => void;
  onAggregate: (aggregate: ClaudeAggregate) => void;
  intervalMs?: number;
  /** Where Claude Code's session files live (default ~/.claude/sessions). */
  sessionsDir?: string;
  /** Where the desktop app keeps its per-session files (default: per platform). */
  appStoreDir?: string;
  /** Watch the foreground window (Windows; default true). Tests turn it off. */
  foreground?: boolean;
}

/** Start polling; returns a stop function. */
export function startClaudeSessions(opts: ClaudeSessionsOptions): () => void {
  const memory = newBoardMemory();
  const sessionsDir = opts.sessionsDir ?? SESSIONS_DIR;
  const store = createAppStore(opts.appStoreDir ?? appStoreDir());
  const arrivals = new Map<string, number>();
  let viewing: string | null | undefined;
  let foreground = '';
  let watcherLive = false;
  let watcher: ChildProcess | null = null;
  let stopped = false;
  let lastCards = '';
  let lastAggregate = '';

  const startWatcher = (exe: string): void => {
    if (stopped) return;
    let child: ChildProcess;
    try {
      child = spawn(exe, [String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      opts.log('claude: fgwatch failed to start: ' + String(e));
      return;
    }
    watcher = child;
    watcherLive = true;
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        foreground = buf.slice(0, i).trim().toLowerCase();
        buf = buf.slice(i + 1);
      }
    });
    let restarted = false;
    const restart = (): void => {
      if (restarted) return;
      restarted = true;
      watcherLive = false;
      if (watcher === child) watcher = null;
      if (!stopped) setTimeout(() => startWatcher(exe), 5000).unref?.();
    };
    // An executable that exists but cannot run raises 'error' asynchronously;
    // unhandled, it would take the whole host down.
    child.on('error', (e) => {
      opts.log('claude: fgwatch error: ' + e.message);
      restart();
    });
    child.on('exit', restart);
  };

  const tick = (): void => {
    // An arrival: the session open in the Claude window, with the window in
    // front, changing to this one. The first tick only establishes where you are.
    const current = watcherLive && foreground === 'claude' ? store.current() : null;
    if (viewing !== undefined && current && current !== viewing) arrivals.set(current, Date.now());
    viewing = current;

    const board = buildBoard(readSessions(sessionsDir), memory, {
      now: Date.now(),
      lang: opts.lang,
      focusedAt: store.focusedAt,
      arrivedAt: (hostId) => arrivals.get(hostId) ?? 0,
    });

    const cards = JSON.stringify(board.cards);
    if (cards !== lastCards) {
      lastCards = cards;
      opts.onCards(board.cards);
    }
    const aggregate = JSON.stringify(board.aggregate);
    if (aggregate !== lastAggregate) {
      lastAggregate = aggregate;
      opts.onAggregate(board.aggregate);
    }
  };

  const timer = setInterval(tick, opts.intervalMs ?? 1000);
  timer.unref?.();
  tick();
  if (opts.foreground !== false) {
    void buildFgwatch(opts.userRoot, opts.packageRoot, opts.log).then((exe) => {
      if (exe) startWatcher(exe);
    });
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    try {
      watcher?.kill();
    } catch {
      // already gone
    }
  };
}
