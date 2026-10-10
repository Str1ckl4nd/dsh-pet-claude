/**
 * Claude Code session source (dsh-pet-claude) — tests.
 *
 * Pins what the pet shows for a given set of native session files: which
 * sessions are listed, the three states, when idle really means done (a session
 * also goes idle the moment it has loaded), the "read" rules (including the one
 * that is easy to get wrong — being on a session when it finishes is NOT reading
 * it), ordering, which session leads the pet, and the file-reading edges.
 *
 * Run: node --experimental-strip-types --test src/host/claude-sessions.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHEER_MS,
  FORGET_MS,
  KEEP_FINISH_MS,
  SETTLE_MS,
  buildBoard,
  defaultLang,
  isOtherProcess,
  lastWorkAt,
  newBoardMemory,
  nextViewing,
  parseSession,
  startClaudeSessions,
  type BoardInputs,
  type BoardMemory,
  type ClaudeAggregate,
  type ClaudeSession,
  type ClaudeSessionCard,
} from './claude-sessions.ts';

const T0 = 1_800_000_000_000;
const STARTED = T0 - 600_000;

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 4242,
    sessionId: 'cli-a',
    name: 'alpha',
    status: 'busy',
    waitingFor: '',
    statusUpdatedAt: T0,
    startedAt: STARTED,
    procStart: '134000000000000000',
    hostSessionId: 'local_a',
    interactive: true,
    ...over,
  };
}

function inputs(over: Partial<BoardInputs> = {}): BoardInputs {
  return { now: T0, lang: 'en', focusedAt: () => 0, arrivedAt: () => 0, workedAt: () => 0, ...over };
}

/** One turn watched from start to end: at work, then idle at `endAt` and settled. */
function finishTurn(memory: BoardMemory = newBoardMemory(), over: Partial<ClaudeSession> = {}, endAt = T0): BoardMemory {
  buildBoard([session({ ...over, status: 'busy', statusUpdatedAt: endAt - 5000 })], memory, inputs({ now: endAt - 1000 }));
  buildBoard([session({ ...over, status: 'idle', statusUpdatedAt: endAt })], memory, inputs({ now: endAt }));
  buildBoard([session({ ...over, status: 'idle', statusUpdatedAt: endAt })], memory, inputs({ now: endAt + SETTLE_MS }));
  return memory;
}

const moods = (cards: ClaudeSessionCard[]): string[] => cards.map((c) => c.name + ':' + c.mood);

describe('parseSession', () => {
  test('reads the fields it needs', () => {
    const s = parseSession({
      pid: 7,
      sessionId: 'x',
      name: 'Ping',
      status: 'waiting',
      waitingFor: 'approve Bash',
      statusUpdatedAt: 5,
      startedAt: 2,
      procStart: '134360660789257391',
      hostSessionId: 'local_x',
      kind: 'interactive',
      cwd: 'C:\\work\\repo',
    });
    assert.deepEqual(s, {
      pid: 7,
      sessionId: 'x',
      name: 'Ping',
      status: 'waiting',
      waitingFor: 'approve Bash',
      statusUpdatedAt: 5,
      startedAt: 2,
      procStart: '134360660789257391',
      hostSessionId: 'local_x',
      interactive: true,
    });
  });

  test('an untitled session is named after its folder', () => {
    assert.equal(parseSession({ pid: 1, sessionId: 'x', cwd: '/home/u/my-repo' })?.name, 'my-repo');
  });

  test('anything unusable is null, never thrown', () => {
    for (const raw of [null, 'x', 3, {}, { sessionId: 'x' }, { pid: 1 }, { pid: 0, sessionId: 'x' }]) {
      assert.equal(parseSession(raw), null);
    }
  });

  test('only kind "interactive" counts as interactive', () => {
    assert.equal(parseSession({ pid: 1, sessionId: 'x', kind: 'print' })?.interactive, false);
  });
});

describe('buildBoard — which sessions are listed', () => {
  test('only desktop-hosted interactive sessions', () => {
    const b = buildBoard(
      [
        session({ pid: 1, name: 'kept' }),
        session({ pid: 2, interactive: false }),
        session({ pid: 3, hostSessionId: '' }),
      ],
      newBoardMemory(),
      inputs(),
    );
    assert.deepEqual(moods(b.cards), ['kept:working']);
  });

  test('the row links to the desktop app session', () => {
    const b = buildBoard([session()], newBoardMemory(), inputs());
    assert.equal(b.cards[0]?.link, 'claude://claude.ai/epitaxy/local_a');
  });
});

describe('buildBoard — states', () => {
  test('busy is working, waiting needs approval', () => {
    const b = buildBoard([session({ pid: 1, status: 'busy' }), session({ pid: 2, status: 'waiting' })], newBoardMemory(), inputs());
    assert.deepEqual(b.cards.map((c) => c.mood).sort(), ['waiting', 'working']);
  });

  test('a turn that just went idle reads as working until it has settled', () => {
    const memory = newBoardMemory();
    buildBoard([session({ status: 'busy' })], memory, inputs({ now: T0 - 1000 }));
    const idle = session({ status: 'idle', statusUpdatedAt: T0 });
    assert.equal(buildBoard([idle], memory, inputs({ now: T0 })).cards[0]?.mood, 'working');
    const later = buildBoard([idle], memory, inputs({ now: T0 + SETTLE_MS }));
    assert.equal(later.cards[0]?.mood, 'success');
    assert.equal(later.cards[0]?.doneAt, T0);
  });

  test('work resuming inside the settle keeps it one turn', () => {
    const memory = newBoardMemory();
    buildBoard([session({ status: 'busy' })], memory, inputs({ now: T0 - 1000 }));
    buildBoard([session({ status: 'idle', statusUpdatedAt: T0 })], memory, inputs({ now: T0 }));
    buildBoard([session({ status: 'busy', statusUpdatedAt: T0 + 1000 })], memory, inputs({ now: T0 + 1000 }));
    const b = buildBoard([session({ status: 'idle', statusUpdatedAt: T0 + 2000 })], memory, inputs({ now: T0 + 2000 + SETTLE_MS - 1 }));
    assert.equal(b.cards[0]?.mood, 'working');
  });

  test('a background shell command left running does not hold the finish back', () => {
    // the turn ends with a dev server still up: Claude Code writes "shell" until it exits
    const memory = newBoardMemory();
    buildBoard([session({ status: 'busy' })], memory, inputs({ now: T0 - 1000 }));
    buildBoard([session({ status: 'shell', statusUpdatedAt: T0 })], memory, inputs({ now: T0 }));
    const b = buildBoard([session({ status: 'shell', statusUpdatedAt: T0 })], memory, inputs({ now: T0 + SETTLE_MS }));
    assert.equal(b.cards[0]?.mood, 'success');
    assert.equal(b.cards[0]?.doneAt, T0);
    // and the server exiting later is no new finish
    const exit = buildBoard([session({ status: 'idle', statusUpdatedAt: T0 + 300_000 })], memory, inputs({ now: T0 + 300_000 }));
    assert.equal(exit.cards[0]?.doneAt, T0);
  });

  test('labels follow the language', () => {
    const b = buildBoard([session({ status: 'waiting' })], newBoardMemory(), inputs({ lang: 'zh' }));
    assert.equal(b.cards[0]?.detail, '需要审批');
  });
});

describe('buildBoard — idle is not always done', () => {
  test('a session that was only opened is not listed', () => {
    const opened = session({ status: 'idle', startedAt: T0, statusUpdatedAt: T0 + 6000 });
    const memory = newBoardMemory();
    for (const now of [T0 + 6000, T0 + 600_000, T0 + 3_600_000]) {
      assert.equal(buildBoard([opened], memory, inputs({ now })).cards.length, 0);
    }
  });

  test('found idle with work since its process started: done, without a cheer', () => {
    const b = buildBoard(
      [session({ status: 'idle', statusUpdatedAt: T0 }), session({ pid: 9, name: 'work', status: 'busy' })],
      newBoardMemory(),
      inputs({ workedAt: (s) => (s.pid === 4242 ? T0 - 2000 : 0) }),
    );
    assert.deepEqual(moods(b.cards), ['work:working', 'alpha:success']);
    assert.equal(b.cards[1]?.doneAt, T0 - 2000); // dated by its last work
    assert.equal(b.aggregate.state, 'working'); // an old finish does not take the lead
  });

  test('found idle: a later status write (a dialog closing) does not undo a read', () => {
    // answered at T0-60s, read at T0-30s, a /model screen closed at T0
    const s = session({ status: 'idle', statusUpdatedAt: T0 });
    const b = buildBoard([s], newBoardMemory(), inputs({ now: T0 + 60_000, workedAt: () => T0 - 60_000, focusedAt: () => T0 - 30_000 }));
    assert.equal(b.cards.length, 0);
  });

  test('a finish seen live keeps its own date through a pet restart', () => {
    // background agents ran on after the answer; you looked in while they ran; the pet saw the finish
    const before = finishTurn();
    const restarted = newBoardMemory();
    for (const [host, k] of before.kept) restarted.kept.set(host, k);
    const s = session({ status: 'idle', statusUpdatedAt: T0 });
    const b = buildBoard([s], restarted, inputs({ now: T0 + 60_000, workedAt: () => T0 - 60_000, focusedAt: () => T0 - 30_000 }));
    assert.equal(b.cards[0]?.doneAt, T0);
  });

  test('found waiting mid-turn: when the wait ends, the turn is done', () => {
    const memory = newBoardMemory();
    const waiting = session({ status: 'waiting', waitingFor: 'approve Bash', statusUpdatedAt: T0 });
    buildBoard([waiting], memory, inputs({ now: T0, workedAt: () => T0 - 1000 }));
    // Esc at the prompt: idle, no busy in between
    const idle = session({ status: 'idle', statusUpdatedAt: T0 + 5000 });
    buildBoard([idle], memory, inputs({ now: T0 + 5000 }));
    const b = buildBoard([idle], memory, inputs({ now: T0 + 5000 + SETTLE_MS }));
    assert.equal(b.cards[0]?.mood, 'success');
    assert.equal(b.cards[0]?.doneAt, T0 + 5000);
  });

  test('found idle with the last answer before its process started: it was reopened, not listed', () => {
    const reopened = session({ status: 'idle', startedAt: T0, statusUpdatedAt: T0 + 1000 });
    const b = buildBoard([reopened], newBoardMemory(), inputs({ now: T0 + 5000, workedAt: () => T0 - 3_600_000 }));
    assert.equal(b.cards.length, 0);
  });

  test('a short real turn before the pet started still counts', () => {
    // the turn ended 6s after the process started; only the transcript can tell
    const s = session({ status: 'idle', startedAt: T0, statusUpdatedAt: T0 + 6000 });
    const b = buildBoard([s], newBoardMemory(), inputs({ now: T0 + 3_600_000, workedAt: () => T0 + 4600 }));
    assert.equal(b.cards[0]?.mood, 'success');
  });

  test('a local command screen is not an approval and does not make it done', () => {
    const memory = newBoardMemory();
    const at = (status: string, statusUpdatedAt: number, waitingFor = ''): ClaudeSession => session({ status, waitingFor, startedAt: T0, statusUpdatedAt });
    buildBoard([at('idle', T0)], memory, inputs({ now: T0 }));
    assert.equal(buildBoard([at('waiting', T0 + 5000, 'dialog open')], memory, inputs({ now: T0 + 5000 })).cards.length, 0);
    assert.equal(buildBoard([at('idle', T0 + 9000)], memory, inputs({ now: T0 + 20_000 })).cards.length, 0);
  });

  test('a pet started after a dialog closed on a session that never worked shows nothing', () => {
    const s = session({ status: 'idle', startedAt: T0, statusUpdatedAt: T0 + 3_600_000 });
    assert.equal(buildBoard([s], newBoardMemory(), inputs({ now: T0 + 3_700_000 })).cards.length, 0);
  });

  test('a real approval request on an opened session is listed', () => {
    const b = buildBoard([session({ status: 'waiting', waitingFor: 'approve Bash', startedAt: T0, statusUpdatedAt: T0 })], newBoardMemory(), inputs());
    assert.equal(b.cards[0]?.mood, 'waiting');
  });

  test('no status yet: still loading, not listed', () => {
    assert.equal(buildBoard([session({ status: '' })], newBoardMemory(), inputs()).cards.length, 0);
  });
});

describe('buildBoard — one process, one track', () => {
  test('/clear inside the process keeps an unread finish', () => {
    const memory = finishTurn();
    const cleared = session({ sessionId: 'cli-b', status: 'idle', statusUpdatedAt: T0 });
    const b = buildBoard([cleared], memory, inputs({ now: T0 + 60_000 }));
    assert.equal(b.cards[0]?.mood, 'success');
    assert.equal(b.cards[0]?.doneAt, T0);
  });

  test('/clear on a session that never worked does not make it done', () => {
    const memory = newBoardMemory();
    buildBoard([session({ status: 'idle', startedAt: T0, statusUpdatedAt: T0 + 1000 })], memory, inputs({ now: T0 + 1000 }));
    const cleared = session({ sessionId: 'cli-b', status: 'idle', startedAt: T0, statusUpdatedAt: T0 + 1000 });
    assert.equal(buildBoard([cleared], memory, inputs({ now: T0 + 1_200_000, workedAt: () => T0 + 500 })).cards.length, 0);
  });

  test('reopened in a new process, a session that never finished starts over', () => {
    const memory = newBoardMemory();
    buildBoard([session({ status: 'busy' })], memory, inputs({ now: T0 }));
    const reopened = session({ pid: 5151, status: 'idle', startedAt: T0 + 60_000, statusUpdatedAt: T0 + 66_000 });
    assert.equal(buildBoard([reopened], memory, inputs({ now: T0 + 70_000 })).cards.length, 0);
  });
});

describe('buildBoard — an unread finish is kept', () => {
  test('the session reopened in a new process (the app restarted) still shows it', () => {
    const memory = finishTurn();
    assert.deepEqual(memory.kept.get('local_a'), { doneAt: T0, name: 'alpha' });
    // the old process is gone for a while, then the app reopens the session
    buildBoard([], memory, inputs({ now: T0 + 40_000 }));
    const reopened = session({ pid: 5151, status: 'idle', startedAt: T0 + 60_000, statusUpdatedAt: T0 + 62_000 });
    const b = buildBoard([reopened], memory, inputs({ now: T0 + 70_000 }));
    assert.equal(b.cards[0]?.mood, 'success');
    assert.equal(b.cards[0]?.doneAt, T0);
    assert.equal(b.aggregate.state, 'success');
  });

  test('a pet restart after /clear still shows it', () => {
    const before = finishTurn();
    const restarted = newBoardMemory();
    for (const [host, k] of before.kept) restarted.kept.set(host, k);
    // same process, new session id with no transcript yet
    const cleared = session({ sessionId: 'cli-b', status: 'idle', statusUpdatedAt: T0 + 30_000 });
    const b = buildBoard([cleared], restarted, inputs({ now: T0 + 35_000 }));
    assert.equal(b.cards[0]?.doneAt, T0);
  });

  test('read, or a new turn, drops it', () => {
    const read = finishTurn();
    buildBoard([session({ status: 'idle' })], read, inputs({ now: T0 + SETTLE_MS + 10, focusedAt: () => T0 + 5 }));
    assert.equal(read.kept.size, 0);
    const next = finishTurn();
    buildBoard([session({ status: 'busy', statusUpdatedAt: T0 + 20_000 })], next, inputs({ now: T0 + 20_000 }));
    assert.equal(next.kept.size, 0);
  });

  test('read while its session is closed: dropped, not shown when reopened', () => {
    const memory = finishTurn();
    buildBoard([], memory, inputs({ now: T0 + 40_000, focusedAt: () => T0 + 30_000 }));
    assert.equal(memory.kept.size, 0);
  });

  test('after a week it is dropped, and not restored', () => {
    const memory = finishTurn();
    buildBoard([], memory, inputs({ now: T0 + KEEP_FINISH_MS + 1 }));
    assert.equal(memory.kept.size, 0);
    const restarted = newBoardMemory();
    restarted.kept.set('local_a', { doneAt: T0, name: 'alpha' });
    const b = buildBoard([session({ pid: 5151, status: 'idle', startedAt: T0 + 10 })], restarted, inputs({ now: T0 + KEEP_FINISH_MS + 1 }));
    assert.equal(b.cards.length, 0);
  });

  test('a new process first seen loading or waiting gets it back once it rests', () => {
    for (const first of [session({ pid: 5151, status: '', startedAt: T0 + 60_000 }), session({ pid: 5151, status: 'waiting', waitingFor: 'Managed settings need your review', startedAt: T0 + 60_000 })]) {
      const memory = finishTurn();
      buildBoard([first], memory, inputs({ now: T0 + 61_000 }));
      const b = buildBoard([session({ pid: 5151, status: 'idle', startedAt: T0 + 60_000, statusUpdatedAt: T0 + 63_000 })], memory, inputs({ now: T0 + 64_000 }));
      assert.equal(b.cards[0]?.doneAt, T0, 'first seen ' + (first.status || 'loading'));
    }
  });

  test('a finish keeps the name it had when /resume switches the conversation', () => {
    const memory = finishTurn();
    const resumed = session({ sessionId: 'cli-b', name: 'beta', status: 'idle', statusUpdatedAt: T0 + 30_000 });
    const b = buildBoard([resumed], memory, inputs({ now: T0 + 35_000 }));
    assert.deepEqual(moods(b.cards), ['alpha:success']);
  });
});

describe('nextViewing — coming back to a session', () => {
  test('the first report after start only sets where you are', () => {
    let v: string | null | undefined;
    let step = nextViewing(v, false, null);
    assert.deepEqual(step, { viewing: undefined, arrived: null });
    v = step.viewing;
    step = nextViewing(v, true, 'local_x'); // Claude already in front on x when the pet starts
    assert.equal(step.arrived, null);
    v = step.viewing;
    step = nextViewing(v, true, null); // another window in front
    v = step.viewing;
    assert.equal(nextViewing(v, true, 'local_x').arrived, 'local_x'); // back to Claude on x
  });

  test('switching sessions inside Claude is an arrival; staying is not', () => {
    assert.equal(nextViewing('local_x', true, 'local_y').arrived, 'local_y');
    assert.equal(nextViewing('local_x', true, 'local_x').arrived, null);
  });

  test('the watcher restarting resets it', () => {
    const lost = nextViewing('local_x', false, null);
    assert.equal(nextViewing(lost.viewing, true, 'local_y').arrived, null);
  });

  test('an unreadable store this tick changes nothing', () => {
    const step = nextViewing('local_x', true, undefined);
    assert.deepEqual(step, { viewing: 'local_x', arrived: null });
    assert.equal(nextViewing(step.viewing, true, 'local_x').arrived, null);
  });
});

describe('isOtherProcess — a pid reused after a crash', () => {
  const started = '134360660789257391';
  test('same start time (within a second) is the same process', () => {
    assert.equal(isOtherProcess(started, 'claude', started), false);
    assert.equal(isOtherProcess('134360660799257390', 'claude', started), false);
  });
  test('a different start time is another process', () => {
    assert.equal(isOtherProcess('134360670000000000', 'claude', started), true);
  });
  test('start unreadable: only a non-Claude process counts as another', () => {
    assert.equal(isOtherProcess('x', 'svchost', started), true);
    assert.equal(isOtherProcess('x', 'claude', started), false);
  });
});

describe('buildBoard — read', () => {
  const settled = (over: Partial<BoardInputs>) =>
    buildBoard([session({ status: 'idle', statusUpdatedAt: T0 })], finishTurn(), inputs({ now: T0 + SETTLE_MS + 1, ...over }));

  test('picking it in the sidebar after it finished hides it', () => {
    assert.equal(settled({ focusedAt: () => T0 + 10 }).cards.length, 0);
  });

  test('coming back to it after it finished hides it', () => {
    assert.equal(settled({ arrivedAt: () => T0 + 10 }).cards.length, 0);
  });

  test('having it open when it finished does not count as reading it', () => {
    const b = settled({ focusedAt: () => T0 - 1000, arrivedAt: () => T0 - 1000 });
    assert.deepEqual(moods(b.cards), ['alpha:success']);
  });

  test('a working session is never hidden by focus', () => {
    const b = buildBoard([session({ status: 'busy' })], newBoardMemory(), inputs({ focusedAt: () => T0 + 10 }));
    assert.equal(b.cards.length, 1);
  });

  test('the next turn finishing after a read shows again', () => {
    const memory = finishTurn();
    const read = { focusedAt: () => T0 + 10 };
    buildBoard([session({ status: 'idle', statusUpdatedAt: T0 })], memory, inputs({ now: T0 + SETTLE_MS + 20, ...read }));
    finishTurn(memory, {}, T0 + 60_000);
    const b = buildBoard([session({ status: 'idle', statusUpdatedAt: T0 + 60_000 })], memory, inputs({ now: T0 + 60_000 + SETTLE_MS + 1, ...read }));
    assert.equal(b.cards[0]?.doneAt, T0 + 60_000);
  });

  test('once read, status noise without a turn does not bring a finish back', () => {
    const memory = finishTurn();
    const read = { focusedAt: () => T0 + 10 };
    buildBoard([session({ status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: T0 + 5000 })], memory, inputs({ now: T0 + 5000, ...read }));
    buildBoard([session({ status: 'shell', statusUpdatedAt: T0 + 7000 })], memory, inputs({ now: T0 + 7000, ...read }));
    const b = buildBoard([session({ status: 'idle', statusUpdatedAt: T0 + 9000 })], memory, inputs({ now: T0 + 9000 + SETTLE_MS, ...read }));
    assert.equal(b.cards.length, 0);
  });
});

describe('buildBoard — order and the pet', () => {
  test('approval first, then working, then done', () => {
    const all = [
      session({ pid: 1, name: 'done', status: 'idle', statusUpdatedAt: T0 - 60_000 }),
      session({ pid: 2, name: 'work', status: 'busy' }),
      session({ pid: 3, name: 'ask', status: 'waiting' }),
    ];
    const b = buildBoard(all, newBoardMemory(), inputs({ workedAt: (s) => (s.pid === 1 ? T0 - 61_000 : 0) }));
    assert.deepEqual(moods(b.cards), ['ask:waiting', 'work:working', 'done:success']);
  });

  test('nothing listed: the pet is idle', () => {
    assert.deepEqual(buildBoard([], newBoardMemory(), inputs()).aggregate, { state: null, task: null });
  });

  test('a fresh finish leads the pet for a few seconds, then the busiest session does', () => {
    const memory = newBoardMemory();
    const work = session({ pid: 2, name: 'work', status: 'busy' });
    buildBoard([work, session({ name: 'done', status: 'busy' })], memory, inputs({ now: T0 - 1000 }));
    const all = [work, session({ name: 'done', status: 'idle', statusUpdatedAt: T0 })];
    buildBoard(all, memory, inputs({ now: T0 }));
    const shown = T0 + SETTLE_MS;
    assert.deepEqual(buildBoard(all, memory, inputs({ now: shown })).aggregate, { state: 'success', task: 'done: Done' });
    assert.deepEqual(buildBoard(all, memory, inputs({ now: shown + CHEER_MS })).aggregate, { state: 'working', task: 'work: Working' });
  });

  test('an approval request outranks a fresh finish', () => {
    const memory = newBoardMemory();
    const ask = session({ pid: 2, name: 'ask', status: 'waiting' });
    buildBoard([ask, session({ name: 'done', status: 'busy' })], memory, inputs({ now: T0 - 1000 }));
    const all = [ask, session({ name: 'done', status: 'idle', statusUpdatedAt: T0 })];
    buildBoard(all, memory, inputs({ now: T0 }));
    const b = buildBoard(all, memory, inputs({ now: T0 + SETTLE_MS }));
    assert.equal(b.cards.find((c) => c.name === 'done')?.mood, 'success');
    assert.deepEqual(b.aggregate, { state: 'waiting', task: 'ask: Needs approval' });
  });

  test('a waiting spell after a finish does not replay its cheer', () => {
    const memory = finishTurn();
    const work = session({ pid: 2, name: 'work', status: 'busy' });
    const later = T0 + SETTLE_MS + CHEER_MS + 5000;
    buildBoard([session({ status: 'idle' }), work], memory, inputs({ now: later }));
    buildBoard([session({ status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: later + 1000 }), work], memory, inputs({ now: later + 1000 }));
    const b = buildBoard([session({ status: 'idle', statusUpdatedAt: later + 2000 }), work], memory, inputs({ now: later + 2000 }));
    assert.equal(b.cards.find((c) => c.name === 'alpha')?.doneAt, T0);
    assert.equal(b.aggregate.state, 'working');
  });

  test('a session that is gone takes its memory with it', () => {
    const memory = newBoardMemory();
    buildBoard([session({ status: 'idle' })], memory, inputs());
    assert.equal(memory.tracks.size, 1);
    buildBoard([], memory, inputs({ now: T0 + FORGET_MS + 1 }));
    assert.equal(memory.tracks.size, 0);
  });
});

describe('defaultLang', () => {
  test('DSH_PET_CLAUDE_LANG wins', () => {
    const before = process.env.DSH_PET_CLAUDE_LANG;
    try {
      process.env.DSH_PET_CLAUDE_LANG = 'en';
      assert.equal(defaultLang(), 'en');
      process.env.DSH_PET_CLAUDE_LANG = 'ZH';
      assert.equal(defaultLang(), 'zh');
    } finally {
      if (before === undefined) delete process.env.DSH_PET_CLAUDE_LANG;
      else process.env.DSH_PET_CLAUDE_LANG = before;
    }
  });
});

describe('lastWorkAt — the transcript', () => {
  const withTranscript = (lines: string[], check: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pet-claude-tx-'));
    try {
      mkdirSync(join(root, 'C--work-repo'));
      writeFileSync(join(root, 'C--work-repo', 'sid-1.jsonl'), lines.join('\n') + '\n');
      check(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test('the newest answer, skipping other entries and a cut-off line', () => {
    withTranscript(
      [
        '{"type":"assistant","timestamp":"2026-10-10T00:34:00.000Z"}',
        '{"type":"user","timestamp":"2026-10-10T00:34:40.984Z"}',
        '{"type":"assistant","timestamp":"2026-10-10T00:34:44.640Z","message":{"content":"pong"}}',
        '{"type":"system","subtype":"stop","timestamp":"2026-10-10T00:34:46.380Z"}',
        '{"type":"assistant","timestamp":"2026-10-10T00:35',
      ],
      (root) => {
        assert.equal(lastWorkAt(root, 'sid-1'), Date.parse('2026-10-10T00:34:44.640Z'));
        assert.equal(lastWorkAt(root, 'missing'), 0);
        assert.equal(lastWorkAt(join(root, 'nope'), 'sid-1'), 0);
      },
    );
  });

  test('a prompt counts as work (Esc before any answer); a system-injected one does not', () => {
    withTranscript(
      [
        '{"type":"assistant","timestamp":"2026-10-10T00:30:00.000Z"}',
        '{"type":"user","timestamp":"2026-10-10T00:31:00.000Z","message":{"content":"[Request interrupted by user]"}}',
        '{"type":"user","isMeta":true,"timestamp":"2026-10-10T00:32:00.000Z"}',
      ],
      (root) => assert.equal(lastWorkAt(root, 'sid-1'), Date.parse('2026-10-10T00:31:00.000Z')),
    );
  });

  test('a slash command and its output are no work', () => {
    withTranscript(
      [
        '{"type":"assistant","timestamp":"2026-10-10T00:30:00.000Z"}',
        '{"type":"user","timestamp":"2026-10-10T00:40:00.000Z","message":{"role":"user","content":"<local-command-caveat>The command below was run directly</local-command-caveat>"}}',
        '{"type":"user","timestamp":"2026-10-10T00:40:00.100Z","message":{"role":"user","content":"<command-name>/model</command-name>\\n            <command-message>model</command-message>"}}',
        '{"type":"user","timestamp":"2026-10-10T00:40:01.000Z","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Set model</local-command-stdout>"}]}}',
        '{"type":"system","subtype":"local_command","timestamp":"2026-10-10T00:40:01.100Z"}',
      ],
      (root) => assert.equal(lastWorkAt(root, 'sid-1'), Date.parse('2026-10-10T00:30:00.000Z')),
    );
  });

  test('found past a line far longer than one read chunk', () => {
    const huge = '{"type":"system","content":"' + 'x'.repeat(3 * 1024 * 1024) + '"}';
    withTranscript(['{"type":"assistant","timestamp":"2026-10-10T00:34:44.640Z"}', huge], (root) =>
      assert.equal(lastWorkAt(root, 'sid-1'), Date.parse('2026-10-10T00:34:44.640Z')),
    );
  });

  test('a line split across chunks is read whole', () => {
    const pad = '{"type":"system","content":"' + 'y'.repeat(256 * 1024 - 40) + '"}';
    withTranscript(['{"type":"assistant","timestamp":"2026-10-10T00:34:44.640Z","message":{"content":"é中"}}', pad, pad], (root) =>
      assert.equal(lastWorkAt(root, 'sid-1'), Date.parse('2026-10-10T00:34:44.640Z')),
    );
  });
});

describe('startClaudeSessions — reads real files', () => {
  const run = async (
    setup: (dirs: { sessions: string; projects: string }) => void,
    during?: (dirs: { sessions: string; projects: string }) => void,
  ): Promise<{ cards: ClaudeSessionCard[][]; aggregates: ClaudeAggregate[] }> => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pet-claude-'));
    const dirs = { sessions: join(root, 'sessions'), projects: join(root, 'projects') };
    mkdirSync(dirs.sessions);
    mkdirSync(join(dirs.projects, 'C--work'), { recursive: true });
    try {
      setup(dirs);
      const cards: ClaudeSessionCard[][] = [];
      const aggregates: ClaudeAggregate[] = [];
      const stop = startClaudeSessions({
        userRoot: join(root, 'user'),
        packageRoot: root,
        lang: 'en',
        log: () => {},
        onCards: (c) => cards.push(c),
        onAggregate: (a) => aggregates.push(a),
        intervalMs: 20,
        sessionsDir: dirs.sessions,
        projectsDir: dirs.projects,
        appStoreDir: join(root, 'no-app-store'),
        foreground: false,
      });
      await new Promise((r) => setTimeout(r, 60));
      during?.(dirs);
      await new Promise((r) => setTimeout(r, 80));
      stop();
      return { cards, aggregates };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  // this test process is a live pid, so its files are not treated as left behind by a crash
  const file = (over: Record<string, unknown>): string =>
    JSON.stringify({ pid: process.pid, sessionId: 'cli-x', name: 'probe', kind: 'interactive', hostSessionId: 'local_x', startedAt: Date.now() - 60_000, ...over });

  test('a live session file becomes a card and drives the pet, reported once', async () => {
    const { cards, aggregates } = await run(({ sessions }) => {
      writeFileSync(join(sessions, `${process.pid}.json`), file({ status: 'busy', statusUpdatedAt: Date.now() }));
    });
    assert.equal(cards.length, 1);
    assert.equal(aggregates.length, 1);
    assert.deepEqual(aggregates[0], { state: 'working', task: 'probe: Working' });
    assert.deepEqual(
      cards[0]?.map((c) => [c.name, c.mood, c.link]),
      [['probe', 'working', 'claude://claude.ai/epitaxy/local_x']],
    );
  });

  test('a file caught mid-write does not drop the session for a tick', async () => {
    const { cards } = await run(
      ({ sessions }) => writeFileSync(join(sessions, `${process.pid}.json`), file({ status: 'busy', statusUpdatedAt: Date.now() })),
      ({ sessions }) => writeFileSync(join(sessions, `${process.pid}.json`), '{"pid":'),
    );
    assert.equal(cards.length, 1);
  });

  test('found idle, its transcript decides: answered since start is done', async () => {
    const { cards } = await run(({ sessions, projects }) => {
      writeFileSync(join(sessions, `${process.pid}.json`), file({ status: 'idle', statusUpdatedAt: Date.now() - 1000 }));
      writeFileSync(join(projects, 'C--work', 'cli-x.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 2000).toISOString() }) + '\n');
    });
    assert.deepEqual(cards[0]?.map((c) => c.mood), ['success']);
  });

  test('found idle with no answer since start: nothing to show', async () => {
    const { cards } = await run(({ sessions, projects }) => {
      writeFileSync(join(sessions, `${process.pid}.json`), file({ status: 'idle', statusUpdatedAt: Date.now() - 1000 }));
      writeFileSync(join(projects, 'C--work', 'cli-x.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 3_600_000).toISOString() }) + '\n');
    });
    assert.deepEqual(cards, [[]]);
  });
});
