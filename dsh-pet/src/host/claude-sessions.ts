/**
 * dsh-pet-claude — Claude Code session source (standalone mode only).
 *
 * Standalone mode has no DeepSeek Harness session stream to feed the work-status
 * pipeline. This module feeds it from Claude Code instead. Claude Code keeps a
 * state file for every running process at ~/.claude/sessions/<pid>.json with
 * the session's title (`name`), its live status and the desktop app's id for it
 * (`hostSessionId`). Nothing has to be installed into the sessions themselves,
 * and sessions already running when the pet starts are covered.
 *
 * Status, as Claude Code writes it:
 *   busy     a turn is running, or background agents are — so idle after work
 *            means the work is really over
 *   waiting  something needs you: a permission prompt, a question… Also written
 *            for a local command's own screen such as /model ("dialog open"),
 *            which waits on nobody but you; that one counts as idle here
 *   shell    idle with a background shell command still running (a dev server,
 *            say): the turn is over, so this counts as idle too
 *   idle     nothing running
 *
 * Idle alone is not "done": a session also goes idle as soon as it has loaded —
 * opening an old one, or the app reopening its sessions after a restart. So a
 * session is done once it was seen working and then went idle. One already idle
 * the first time the pet sees it is done only if its transcript shows work (a
 * prompt or an answer) since its process started, or if an unread finish was
 * kept for it from before (an earlier process, an earlier run of the pet).
 *
 * Two outputs, each called only when it changed:
 *   - onCards:     the session board for the panel (sections.claudeSessions)
 *   - onAggregate: one state + headline for the pet (sections.workStatus), which
 *                  the renderer animates through its native work-status path.
 *
 * "Read": a finished session stays on the board until you go to it after it
 * finished — pick it in the desktop app's sidebar (its lastFocusedAt moves), or
 * come back to the Claude window with it open (Windows: fgwatch reports the
 * foreground process; these arrivals are kept on disk across pet restarts).
 * Having it open at the moment it finishes does not count.
 *
 * Self-contained (no src/shared imports), like the rest of src/host.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  /** What a waiting session waits for: a permission prompt, a dialog… */
  waitingFor: string;
  statusUpdatedAt: number;
  /** When the session's process started. */
  startedAt: number;
  /** The process's creation time as Claude Code recorded it (Windows: a FILETIME); '' when absent. */
  procStart: string;
  hostSessionId: string;
  interactive: boolean;
}

export const CLAUDE_LABELS: Record<ClaudeLang, Record<ClaudeMood, string>> = {
  zh: { working: '正在工作', waiting: '需要审批', success: '已经完成' },
  en: { working: 'Working', waiting: 'Needs approval', success: 'Done' },
};

const RANK: Record<ClaudeMood, number> = { waiting: 3, working: 2, success: 1 };

/** A short settle on a fresh idle keeps a between-turns blink off the panel. */
export const SETTLE_MS = 3000;
/** How long a fresh finish leads the pet before the busiest state takes over again. */
export const CHEER_MS = 6000;
/** A session missing for this long is gone. */
export const FORGET_MS = 10_000;
/** A kept finish older than this is dropped. */
export const KEEP_FINISH_MS = 7 * 24 * 3600_000;

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
    waitingFor: str(r.waitingFor),
    statusUpdatedAt: num(r.statusUpdatedAt),
    startedAt: num(r.startedAt),
    procStart: typeof r.procStart === 'number' ? String(r.procStart) : str(r.procStart),
    hostSessionId: str(r.hostSessionId),
    interactive: r.kind === 'interactive',
  };
}

/** What buildBoard remembers about one session process between ticks. */
export interface ClaudeTrack {
  /** A turn is under way: seen at work since its last finish. */
  active: boolean;
  /** When its last turn finished; null while none has (as far as we know). */
  doneAt: number | null;
  /** The session's name when it finished. */
  doneName: string;
  /** A kept finish may still be restored: this process has not rested or worked yet. */
  restorable: boolean;
  /** When the current turn was first seen idle; it settles before it counts. */
  idleSince: number | null;
  /** When the current finish first reached the board; 0 = found finished, no cheer. */
  shownAt: number | null;
  /** The last tick that saw its file. */
  seenAt: number;
}

/** An unread finish, kept per desktop session so it outlives its process and the pet. */
export interface KeptFinish {
  doneAt: number;
  name: string;
}

/** What buildBoard remembers between ticks. */
export interface BoardMemory {
  /** One track per session process. */
  tracks: Map<string, ClaudeTrack>;
  /** hostSessionId → its unread finish (persisted by the caller). */
  kept: Map<string, KeptFinish>;
}

export function newBoardMemory(): BoardMemory {
  return { tracks: new Map(), kept: new Map() };
}

export interface BoardInputs {
  now: number;
  lang: ClaudeLang;
  /** The desktop app's lastFocusedAt for a session (0 when unknown). */
  focusedAt: (hostSessionId: string) => number;
  /** When you last came back to a session in the Claude window (0 when never). */
  arrivedAt: (hostSessionId: string) => number;
  /** When the session last did work — a prompt or an answer — from its transcript (0 when unknown). Asked on first sight only. */
  workedAt: (session: ClaudeSession) => number;
}

/** What a status means here: at work, waiting on you, idle, or nothing yet (still loading). */
function phaseOf(s: ClaudeSession): 'working' | 'waiting' | 'idle' | '' {
  if (s.status === 'idle' || s.status === 'shell') return 'idle';
  if (s.status === 'waiting') return s.waitingFor === 'dialog open' ? 'idle' : 'waiting';
  return s.status ? 'working' : '';
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
  const read = (host: string, doneAt: number): boolean => inp.focusedAt(host) >= doneAt || inp.arrivedAt(host) > doneAt;

  for (const s of sessions) {
    if (!s.interactive || !s.hostSessionId) continue;
    const host = s.hostSessionId;
    // Per process. /clear and /resume switch the session id inside one process,
    // and a finish carries over; a session reopened in a new process starts over.
    const key = s.pid + '@' + (s.startedAt || s.procStart);
    const phase = phaseOf(s);
    let t = memory.tracks.get(key);
    if (!t) {
      t = { active: false, doneAt: null, doneName: s.name, restorable: true, idleSince: null, shownAt: null, seenAt: inp.now };
      if (phase === 'idle' || phase === 'waiting') {
        const worked = inp.workedAt(s);
        const since = worked > 0 && worked >= s.startedAt;
        if (phase === 'waiting') {
          // Waiting inside a turn: it is done when the wait ends.
          if (since) t.active = true;
        } else if (since) {
          // Found finished: dated by its last work. Later status writes — a
          // dialog closing, a background shell ending — are no new finish and
          // must not undo a read. It gets no cheer.
          t.doneAt = worked;
          t.shownAt = 0;
        }
      }
      memory.tracks.set(key, t);
    }
    t.seenAt = inp.now;

    let mood: ClaudeMood | null = null;
    let doneAt: number | null = null;
    if (phase === 'idle') {
      if (t.active) {
        // The turn went idle. Let it settle first: work can resume right away.
        if (t.idleSince === null) t.idleSince = inp.now;
        if (inp.now - t.idleSince >= SETTLE_MS) {
          t.active = false;
          t.idleSince = null;
          t.doneAt = s.statusUpdatedAt || inp.now;
          t.doneName = s.name;
          t.shownAt = null; // a new finish, with its own cheer
        }
      } else if (t.restorable) {
        // An unread finish kept from before — an earlier process of this
        // session, or the pet's last run — once this process first rests.
        const kept = memory.kept.get(host);
        if (kept && inp.now - kept.doneAt <= KEEP_FINISH_MS && (t.doneAt === null || kept.doneAt > t.doneAt)) {
          t.doneAt = kept.doneAt;
          t.doneName = kept.name;
          t.shownAt = 0;
        }
      }
      t.restorable = false;
      if (t.active) {
        mood = 'working';
      } else if (t.doneAt !== null) {
        mood = 'success';
        doneAt = t.doneAt;
      }
    } else if (phase === 'waiting') {
      t.idleSince = null;
      mood = 'waiting';
    } else if (phase === 'working') {
      t.active = true;
      t.restorable = false;
      t.idleSince = null;
      mood = 'working';
      memory.kept.delete(host); // a new turn: its own finish will be kept
    }

    if (doneAt !== null && read(host, doneAt)) {
      mood = null;
      memory.kept.delete(host);
    } else if (mood === 'success' && doneAt !== null) {
      memory.kept.set(host, { doneAt, name: t.doneName });
    }
    if (mood === null) continue;
    if (mood === 'success' && t.shownAt === null) t.shownAt = inp.now;

    rows.push({
      card: {
        // A finish keeps the name it had: /resume can switch the conversation after it.
        name: mood === 'success' ? t.doneName : s.name,
        detail: label[mood],
        mood,
        doneAt,
        link: 'claude://claude.ai/epitaxy/' + host,
      },
      shownAt: mood === 'success' ? t.shownAt : null,
    });
  }

  // Sessions that are gone take their memory with them; a kept finish stays
  // for a while in case the session is reopened, and is dropped once read.
  for (const [key, t] of [...memory.tracks]) if (inp.now - t.seenAt > FORGET_MS) memory.tracks.delete(key);
  for (const [host, k] of [...memory.kept]) {
    if (inp.now - k.doneAt > KEEP_FINISH_MS || read(host, k.doneAt)) memory.kept.delete(host);
  }

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

/**
 * Where you are in the Claude window, tick by tick. An arrival is the session on
 * screen — the window in front, and the session it shows — changing to another
 * one. Until the foreground has been reported (the pet just started, or the
 * watcher restarted) there is no "before", so the first report only sets it.
 * `current` is null when Claude is not in front, undefined when the app's store
 * could not be read this tick (nothing is known, nothing changes).
 */
export function nextViewing(
  before: string | null | undefined,
  reported: boolean,
  current: string | null | undefined,
): { viewing: string | null | undefined; arrived: string | null } {
  if (!reported) return { viewing: undefined, arrived: null };
  if (current === undefined) return { viewing: before, arrived: null };
  const arrived = before !== undefined && current !== null && current !== before ? current : null;
  return { viewing: current, arrived };
}

/**
 * One line of the process check: "<pid> <start FILETIME or x> <name>". Another
 * process holds the pid when its start time differs from the recorded one by
 * more than a second, or — start unreadable, as for elevated and system
 * processes — when it is not a Claude process at all.
 */
export function isOtherProcess(start: string, name: string, procStart: string): boolean {
  if (/^\d+$/.test(start)) {
    const gap = BigInt(start) - BigInt(procStart);
    return (gap < 0n ? -gap : gap) > 10_000_000n; // FILETIME ticks: 1s
  }
  return name.toLowerCase() !== 'claude';
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
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
/** A transcript is searched backwards in chunks of this size… */
const SCAN_CHUNK = 256 * 1024;
/** …up to this much of its end. */
const SCAN_MAX = 8 * 1024 * 1024;
/** How often live session pids are re-checked against the process that holds them now. */
const IDENTITY_RECHECK_MS = 10 * 60_000;
/** Arrivals older than this are dropped from the file. */
const ARRIVALS_KEEP_MS = 30 * 24 * 3600_000;
/** How long a read receipt is reused before its file is read again. */
const FOCUS_TTL_MS = 3000;
/** How long a new session waits off the board for the process check before it is shown anyway. */
const IDENTITY_WAIT_MS = 3000;

/** Where the desktop app keeps its per-session files (read receipts). */
function appStoreDir(): string {
  if (process.platform === 'win32') {
    const direct = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
    if (existsSync(direct)) return direct;
    // The desktop app is a packaged (MSIX) app: what it writes under %APPDATA%
    // really lives in %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming.
    // Programs started from inside the app see it at %APPDATA%; the pet, started
    // on its own, sees only the real folder.
    const packages = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Packages');
    try {
      for (const d of readdirSync(packages)) {
        if (!/^Claude_/i.test(d)) continue;
        const p = join(packages, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions');
        if (existsSync(p)) return p;
      }
    } catch {
      // no packaged app here
    }
    return direct;
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
  // A session file is rewritten in place; a read can land mid-write. Retry once.
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch {
      // try again
    }
  }
  return null;
}

/**
 * Reads the session directory. A file caught mid-write keeps its last good
 * parse, so one torn read does not drop a session for a tick. Returns null when
 * the directory itself cannot be read: the caller keeps the board it has.
 */
function createSessionReader(dir: string): () => ClaudeSession[] | null {
  const lastGood = new Map<string, ClaudeSession>();
  return () => {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return null;
    }
    const out: ClaudeSession[] = [];
    const present = new Set(files);
    for (const f of files) {
      // The file is named after its pid: one left behind by a dead process is not even read.
      const named = Number(f.slice(0, -5));
      if (Number.isInteger(named) && named > 0 && !isAlive(named)) continue;
      let s = parseSession(readJson(join(dir, f)));
      if (s) lastGood.set(f, s);
      else s = lastGood.get(f) ?? null;
      if (s && isAlive(s.pid)) out.push(s);
    }
    for (const f of [...lastGood.keys()]) if (!present.has(f)) lastGood.delete(f);
    return out;
  };
}

/** A slash command and its output are written as user lines too; neither is work. */
function isCommandLine(content: unknown): boolean {
  const first: unknown = Array.isArray(content) ? content[0] : content;
  const text = typeof first === 'string' ? first : first && typeof first === 'object' ? (first as { text?: unknown }).text : '';
  return typeof text === 'string' && /^\s*<(command-name|command-message|local-command-)/.test(text);
}

/** When a transcript line records work: an answer, or a prompt — not a system-injected line or a slash command. */
function workTime(line: string): number {
  if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return 0;
  try {
    const o = JSON.parse(line) as { type?: unknown; isMeta?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    if (o.type === 'user') {
      if (o.isMeta === true || isCommandLine(o.message?.content)) return 0;
    } else if (o.type !== 'assistant') {
      return 0;
    }
    if (typeof o.timestamp !== 'string') return 0;
    const t = Date.parse(o.timestamp);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0; // a line cut off by the chunk edge or by a write in progress
  }
}

/**
 * When a session last did work: the newest prompt or answer in its transcript,
 * ~/.claude/projects/<project>/<sessionId>.jsonl, searched backwards from the
 * end. 0 when there is no transcript or no work in its last 8 MB.
 */
export function lastWorkAt(projectsDir: string, sessionId: string): number {
  let file = '';
  try {
    for (const d of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(projectsDir, d.name, sessionId + '.jsonl');
      if (existsSync(f)) {
        file = f;
        break;
      }
    }
  } catch {
    return 0;
  }
  if (!file) return 0;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return 0;
  }
  try {
    const size = fstatSync(fd).size;
    let end = size;
    // The head of a line whose start lies in the next (earlier) chunk.
    let head: Buffer = Buffer.alloc(0);
    while (end > 0 && size - end < SCAN_MAX) {
      const start = Math.max(0, end - SCAN_CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk, head]);
      const cut = start === 0 ? -1 : data.indexOf(0x0a);
      if (start > 0 && cut < 0) {
        head = data; // one line longer than the chunk: keep reading backwards
        end = start;
        continue;
      }
      head = cut < 0 ? Buffer.alloc(0) : data.subarray(0, cut);
      const lines = data.subarray(cut + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = workTime(lines[i] ?? '');
        if (t > 0) return t;
      }
      end = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}

/**
 * Windows: a pid in a session file left behind by a crash can be reused by an
 * unrelated process, which then passes the liveness test. Claude Code records
 * each process's creation time (procStart); compare it with whatever holds the
 * pid now, as Claude Code itself does. One PowerShell query covers the listed
 * sessions: when an unchecked process appears, and every ten minutes. A
 * session waits off the board for its first answer (about 0.3s), so a stale
 * file does not flash up; if no answer comes within a few seconds it is shown.
 */
function createIdentityCheck(log: (m: string) => void): { refresh: (listed: ClaudeSession[]) => void; hide: (s: ClaudeSession) => boolean } {
  const verdicts = new Map<string, boolean>(); // pid@procStart → another process holds the pid
  const firstSeen = new Map<string, number>();
  let running = false;
  let checkedAt = 0;
  const idOf = (s: ClaudeSession): string => s.pid + '@' + s.procStart;
  const checkable = (s: ClaudeSession): boolean => process.platform === 'win32' && /^\d+$/.test(s.procStart);

  return {
    hide: (s) => {
      if (!checkable(s)) return false;
      const v = verdicts.get(idOf(s));
      if (v !== undefined) return v;
      return Date.now() - (firstSeen.get(idOf(s)) ?? Date.now()) < IDENTITY_WAIT_MS;
    },
    refresh: (listed) => {
      const list = listed.filter(checkable);
      const now = Date.now();
      for (const s of list) if (!firstSeen.has(idOf(s))) firstSeen.set(idOf(s), now);
      for (const id of [...firstSeen.keys()]) if (!list.some((s) => idOf(s) === id)) firstSeen.delete(id);
      if (running || !list.length) return;
      const unchecked = list.some((s) => !verdicts.has(idOf(s)));
      if (!unchecked && Date.now() - checkedAt < IDENTITY_RECHECK_MS) return;
      running = true;
      checkedAt = Date.now();
      const pids = [...new Set(list.map((s) => s.pid))].join(',');
      const ps =
        'Get-Process -Id ' + pids + ' -ErrorAction SilentlyContinue | ForEach-Object { ' +
        "$t = try { $_.StartTime.ToFileTimeUtc() } catch { 'x' }; '' + $_.Id + ' ' + $t + ' ' + $_.ProcessName }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
        running = false;
        if (err && !stdout) log('claude: checking session processes failed: ' + err.message);
        const held = new Map<number, { start: string; name: string }>();
        for (const line of String(stdout ?? '').split(/\r?\n/)) {
          const [pid, start, ...name] = line.trim().split(' ');
          if (pid && start) held.set(Number(pid), { start, name: name.join(' ') });
        }
        // No answer for a pid (it exited meanwhile, or the query failed): trust
        // the liveness test, and wait for the next round rather than retry every tick.
        for (const s of list) {
          const h = held.get(s.pid);
          verdicts.set(idOf(s), h !== undefined && isOtherProcess(h.start, h.name, s.procStart));
        }
        const live = new Set(list.map(idOf));
        for (const id of [...verdicts.keys()]) if (!live.has(id)) verdicts.delete(id);
      });
    },
  };
}

/**
 * The desktop app's read receipts. lastFocusedAt is stamped when you pick a
 * session in the sidebar; the session open right now is the newest stamp. A
 * session's own receipt is read from its own file, at most every few seconds;
 * the whole store is scanned only to find the open session, which the caller
 * asks for only while the Claude window is in front, and only files that
 * changed are read again. A file caught mid-write keeps its last stamp.
 */
function createAppStore(root: string): {
  focusedAt: (hostId: string) => number;
  current: () => string | null | undefined;
} {
  const folders = new Map<string, string>(); // hostId → the folder holding its file
  const stamps = new Map<string, { at: number; value: number }>();
  const seen = new Map<string, string>(); // file → mtime:size when last read
  let scannedAt = 0;
  let newest: string | null | undefined;

  // Only a complete number counts: a file cut off mid-write can end inside one.
  const readStamp = (file: string, before: number): number => {
    try {
      const m = /"lastFocusedAt"\s*:\s*(\d+)\s*[,}]/.exec(readFileSync(file, 'utf8'));
      return m ? Number(m[1]) : before;
    } catch {
      return before;
    }
  };
  const subfolders = (): string[] => {
    const out: string[] = [];
    try {
      for (const a of readdirSync(root, { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        for (const i of readdirSync(join(root, a.name), { withFileTypes: true })) if (i.isDirectory()) out.push(join(root, a.name, i.name));
      }
    } catch {
      // No desktop app store on this machine: no read receipts, everything else still works.
    }
    return out;
  };

  return {
    focusedAt: (hostId) => {
      const now = Date.now();
      const hit = stamps.get(hostId);
      if (hit && now - hit.at < FOCUS_TTL_MS) return hit.value;
      let folder = folders.get(hostId);
      if (!folder) {
        folder = subfolders().find((d) => existsSync(join(d, hostId + '.json')));
        if (folder) folders.set(hostId, folder);
      }
      const value = folder ? readStamp(join(folder, hostId + '.json'), hit?.value ?? 0) : 0;
      stamps.set(hostId, { at: now, value });
      return value;
    },
    current: () => {
      const now = Date.now();
      if (now - scannedAt < 1500) return newest;
      scannedAt = now;
      let best = 0;
      let found: string | null = null;
      let readable = false;
      for (const dir of subfolders()) {
        let files: string[];
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        readable = true;
        for (const f of files) {
          if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
          const id = f.slice(0, -5);
          const file = join(dir, f);
          let value = stamps.get(id)?.value ?? 0;
          try {
            const st = statSync(file);
            const sig = st.mtimeMs + ':' + st.size;
            if (seen.get(file) !== sig) {
              value = readStamp(file, value);
              seen.set(file, sig);
            }
          } catch {
            continue;
          }
          folders.set(id, dir);
          stamps.set(id, { at: now, value });
          if (value > best) {
            best = value;
            found = id;
          }
        }
      }
      // The store could not be read at all: nothing is known this time.
      newest = readable ? found : undefined;
      return newest;
    },
  };
}

/** Small JSON maps kept in the pet's user directory, written only when they change. */
function loadMap(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function saveMap(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write aside, then swap in: a write cut short never leaves a truncated file to load as empty.
    writeFileSync(file + '.tmp', JSON.stringify(value));
    renameSync(file + '.tmp', file);
  } catch {
    // kept in memory for this run
  }
}

/** Coming back to a session is a read the app does not record; keep it across pet restarts. */
function createArrivals(file: string): { get: (hostId: string) => number; mark: (hostId: string, at: number) => void } {
  const at = new Map<string, number>();
  const cutoff = Date.now() - ARRIVALS_KEEP_MS;
  for (const [id, v] of Object.entries(loadMap(file))) if (typeof v === 'number' && v > cutoff) at.set(id, v);
  return {
    get: (hostId) => at.get(hostId) ?? 0,
    mark: (hostId, when) => {
      at.set(hostId, when);
      saveMap(file, Object.fromEntries(at));
    },
  };
}

/**
 * fgwatch: reports the foreground app — once at start, then only on change —
 * by subscribing to the OS's own "app switched" event and sleeping otherwise.
 * Built here on first use with a compiler the OS already has; nothing is
 * downloaded. Windows: src/host/fgwatch.cs with the .NET Framework's csc.exe.
 * macOS: src/host/fgwatch.swift with swiftc from the Xcode Command Line Tools.
 */
function buildFgwatch(userRoot: string, packageRoot: string, log: (m: string) => void): Promise<string | null> {
  const mac = process.platform === 'darwin';
  if (process.platform !== 'win32' && !mac) return Promise.resolve(null);
  const src = join(packageRoot, 'src', 'host', mac ? 'fgwatch.swift' : 'fgwatch.cs');
  const exe = join(userRoot, mac ? 'fgwatch' : 'fgwatch.exe');
  if (!existsSync(src)) return Promise.resolve(null);
  try {
    if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(src).mtimeMs) return Promise.resolve(exe);
  } catch {
    // fall through and rebuild
  }
  const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  // macOS: only a real toolchain (Command Line Tools or Xcode) — calling the
  // /usr/bin/swiftc stub without one pops up the "install developer tools" dialog.
  const swiftc = [
    '/Library/Developer/CommandLineTools/usr/bin/swiftc',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc',
  ].find((p) => existsSync(p));
  const compiler = mac ? (swiftc ?? '') : csc;
  if (!compiler || !existsSync(compiler)) {
    log('claude: no ' + (mac ? 'Swift' : 'C#') + ' compiler found; coming back to a session will not mark it read');
    return Promise.resolve(null);
  }
  try {
    mkdirSync(userRoot, { recursive: true });
  } catch {
    return Promise.resolve(null);
  }
  // macOS goes through xcrun, which hands swiftc the SDK; called bare it cannot load the standard library.
  const run = mac ? '/usr/bin/xcrun' : compiler;
  const args = mac ? ['swiftc', '-O', '-o', exe, src] : ['-nologo', '-target:exe', '-optimize+', '-out:' + exe, src];
  return new Promise((resolve) => {
    execFile(run, args, { windowsHide: true, timeout: 300_000 }, (err) => {
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
  /** dsh-pet's user directory (~/.dsh/dsh-pet): where fgwatch.exe is built and arrivals and unread finishes are kept. */
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
  /** Where Claude Code keeps transcripts (default ~/.claude/projects). */
  projectsDir?: string;
  /** Where the desktop app keeps its per-session files (default: per platform). */
  appStoreDir?: string;
  /** Watch the foreground window and check pids (Windows; default true). Tests turn it off. */
  foreground?: boolean;
}

/** Start polling; returns a stop function. */
export function startClaudeSessions(opts: ClaudeSessionsOptions): () => void {
  const memory = newBoardMemory();
  const readSessions = createSessionReader(opts.sessionsDir ?? SESSIONS_DIR);
  const projectsDir = opts.projectsDir ?? PROJECTS_DIR;
  const store = createAppStore(opts.appStoreDir ?? appStoreDir());
  const arrivals = createArrivals(join(opts.userRoot, 'claude-arrivals.json'));
  const keptFile = join(opts.userRoot, 'claude-finishes.json');
  for (const [host, v] of Object.entries(loadMap(keptFile))) {
    const k = v as Partial<KeptFinish> | null;
    if (k && typeof k.doneAt === 'number' && typeof k.name === 'string' && Date.now() - k.doneAt <= KEEP_FINISH_MS) {
      memory.kept.set(host, { doneAt: k.doneAt, name: k.name });
    }
  }
  let lastKept = JSON.stringify(Object.fromEntries(memory.kept));
  const identity = createIdentityCheck(opts.log);
  const watchOs = opts.foreground !== false;
  let viewing: string | null | undefined;
  let foreground = '';
  /** fgwatch has reported at least once since it started (a nameless window reports ''). */
  let reported = false;
  /** When the Claude window last came to the front. */
  let frontSince = 0;
  let watcherLive = false;
  let watcher: ChildProcess | null = null;
  let failures = 0;
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
    const bornAt = Date.now();
    watcher = child;
    watcherLive = true;
    foreground = '';
    reported = false;
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const name = buf.slice(0, i).trim().toLowerCase();
        buf = buf.slice(i + 1);
        if (name === 'claude' && (foreground !== 'claude' || !reported)) frontSince = Date.now();
        foreground = name;
        reported = true;
      }
    });
    let restarted = false;
    const restart = (): void => {
      if (restarted) return;
      restarted = true;
      watcherLive = false;
      foreground = '';
      reported = false;
      if (watcher === child) watcher = null;
      // A watcher that keeps dying backs off, from 5s up to 5 minutes.
      failures = Date.now() - bornAt > 60_000 ? 0 : failures + 1;
      if (!stopped) setTimeout(() => startWatcher(exe), Math.min(5000 * 2 ** failures, 300_000)).unref?.();
    };
    // An executable that exists but cannot run raises 'error' asynchronously;
    // unhandled, it would take the whole host down.
    child.on('error', (e) => {
      if (failures === 0) opts.log('claude: fgwatch error: ' + e.message);
      restart();
    });
    child.on('exit', restart);
  };

  const tick = (): void => {
    const live = watcherLive && reported;
    const step = nextViewing(viewing, live, live && foreground === 'claude' ? store.current() : null);
    viewing = step.viewing;
    // Dated when the session came on screen — picked in the sidebar, or the
    // window brought to the front — not when this tick noticed it.
    if (step.arrived) arrivals.mark(step.arrived, Math.max(store.focusedAt(step.arrived), frontSince) || Date.now());

    const all = readSessions();
    if (all === null) return; // the directory could not be read: keep what is shown
    const listed = all.filter((s) => s.interactive && s.hostSessionId);
    if (watchOs) identity.refresh(listed);

    const board = buildBoard(
      watchOs ? listed.filter((s) => !identity.hide(s)) : listed,
      memory,
      {
        now: Date.now(),
        lang: opts.lang,
        focusedAt: store.focusedAt,
        arrivedAt: arrivals.get,
        workedAt: (s) => lastWorkAt(projectsDir, s.sessionId),
      },
    );

    const kept = JSON.stringify(Object.fromEntries(memory.kept));
    if (kept !== lastKept) {
      lastKept = kept;
      saveMap(keptFile, Object.fromEntries(memory.kept));
    }
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
  if (watchOs) {
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
