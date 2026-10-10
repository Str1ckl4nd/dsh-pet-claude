/**
 * Claude Code session source (dsh-pet-claude) — unit tests for the pure core.
 *
 * Pins what the pet shows for a given set of native session files: which
 * sessions are listed, the three states, the "read" rules (including the one
 * that is easy to get wrong — being on a session when it finishes is NOT
 * reading it), ordering, and which session leads the pet.
 *
 * Run: node --experimental-strip-types --test src/host/claude-sessions.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHEER_MS,
  SETTLE_MS,
  buildBoard,
  defaultLang,
  newBoardMemory,
  parseSession,
  type BoardInputs,
  type ClaudeSession,
} from './claude-sessions.ts';

const T0 = 1_800_000_000_000;

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 4242,
    sessionId: 'cli-a',
    name: 'alpha',
    status: 'busy',
    statusUpdatedAt: T0,
    hostSessionId: 'local_a',
    interactive: true,
    ...over,
  };
}

function inputs(over: Partial<BoardInputs> = {}): BoardInputs {
  return { now: T0, lang: 'en', focusedAt: () => 0, arrivedAt: () => 0, ...over };
}

describe('parseSession', () => {
  test('reads the fields it needs', () => {
    const s = parseSession({
      pid: 7,
      sessionId: 'x',
      name: 'Ping',
      status: 'idle',
      statusUpdatedAt: 5,
      hostSessionId: 'local_x',
      kind: 'interactive',
      cwd: 'C:\\work\\repo',
    });
    assert.deepEqual(s, {
      pid: 7,
      sessionId: 'x',
      name: 'Ping',
      status: 'idle',
      statusUpdatedAt: 5,
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
        session({ sessionId: 'a', name: 'kept' }),
        session({ sessionId: 'b', interactive: false }),
        session({ sessionId: 'c', hostSessionId: '' }),
      ],
      newBoardMemory(),
      inputs(),
    );
    assert.deepEqual(
      b.cards.map((c) => c.name),
      ['kept'],
    );
  });

  test('the row links to the desktop app session', () => {
    const b = buildBoard([session()], newBoardMemory(), inputs());
    assert.equal(b.cards[0]?.link, 'claude://claude.ai/epitaxy/local_a');
  });
});

describe('buildBoard — states', () => {
  test('busy and shell are working, waiting needs approval', () => {
    const b = buildBoard(
      [session({ sessionId: 'a', status: 'busy' }), session({ sessionId: 'b', status: 'shell' }), session({ sessionId: 'c', status: 'waiting' })],
      newBoardMemory(),
      inputs(),
    );
    assert.deepEqual(
      b.cards.map((c) => c.mood).sort(),
      ['waiting', 'working', 'working'],
    );
  });

  test('a fresh idle reads as working until it has settled', () => {
    const memory = newBoardMemory();
    const s = session({ status: 'idle', statusUpdatedAt: T0 });
    assert.equal(buildBoard([s], memory, inputs({ now: T0 })).cards[0]?.mood, 'working');
    const later = buildBoard([s], memory, inputs({ now: T0 + SETTLE_MS }));
    assert.equal(later.cards[0]?.mood, 'success');
    assert.equal(later.cards[0]?.doneAt, T0);
  });

  test('labels follow the language', () => {
    const b = buildBoard([session({ status: 'waiting' })], newBoardMemory(), inputs({ lang: 'zh' }));
    assert.equal(b.cards[0]?.detail, '需要审批');
  });
});

describe('buildBoard — read', () => {
  const settled = (over: Partial<BoardInputs>) => {
    const memory = newBoardMemory();
    const s = session({ status: 'idle', statusUpdatedAt: T0 });
    buildBoard([s], memory, inputs({ now: T0 }));
    return buildBoard([s], memory, inputs({ now: T0 + SETTLE_MS + 1, ...over }));
  };

  test('picking it in the sidebar after it finished hides it', () => {
    assert.equal(settled({ focusedAt: () => T0 + 10 }).cards.length, 0);
  });

  test('coming back to it after it finished hides it', () => {
    assert.equal(settled({ arrivedAt: () => T0 + 10 }).cards.length, 0);
  });

  test('having it open when it finished does not count as reading it', () => {
    // focused (and arrived) before it finished: the check mark must stay
    const b = settled({ focusedAt: () => T0 - 1000, arrivedAt: () => T0 - 1000 });
    assert.equal(b.cards.length, 1);
    assert.equal(b.cards[0]?.mood, 'success');
  });

  test('a working session is never hidden by focus', () => {
    const b = buildBoard([session({ status: 'busy' })], newBoardMemory(), inputs({ focusedAt: () => T0 + 10 }));
    assert.equal(b.cards.length, 1);
  });
});

describe('buildBoard — order and the pet', () => {
  test('approval first, then working, then done', () => {
    const memory = newBoardMemory();
    const all = [
      session({ sessionId: 'd', name: 'done', status: 'idle', statusUpdatedAt: T0 - 60_000 }),
      session({ sessionId: 'w', name: 'work', status: 'busy' }),
      session({ sessionId: 'q', name: 'ask', status: 'waiting' }),
    ];
    buildBoard(all, memory, inputs({ now: T0 - SETTLE_MS * 10 }));
    const b = buildBoard(all, memory, inputs({ now: T0 }));
    assert.deepEqual(
      b.cards.map((c) => c.name),
      ['ask', 'work', 'done'],
    );
  });

  test('nothing listed: the pet is idle', () => {
    assert.deepEqual(buildBoard([], newBoardMemory(), inputs()).aggregate, { state: null, task: null });
  });

  test('a fresh finish leads the pet for a few seconds, then the busiest session does', () => {
    const memory = newBoardMemory();
    const all = [session({ sessionId: 'w', name: 'work', status: 'busy' }), session({ sessionId: 'd', name: 'done', status: 'idle', statusUpdatedAt: T0 })];
    buildBoard(all, memory, inputs({ now: T0 }));
    const shown = T0 + SETTLE_MS;
    assert.deepEqual(buildBoard(all, memory, inputs({ now: shown })).aggregate, { state: 'success', task: 'done: Done' });
    assert.deepEqual(buildBoard(all, memory, inputs({ now: shown + CHEER_MS })).aggregate, { state: 'working', task: 'work: Working' });
  });

  test('an approval request outranks a fresh finish', () => {
    const memory = newBoardMemory();
    const all = [session({ sessionId: 'q', name: 'ask', status: 'waiting' }), session({ sessionId: 'd', name: 'done', status: 'idle', statusUpdatedAt: T0 })];
    buildBoard(all, memory, inputs({ now: T0 }));
    assert.deepEqual(buildBoard(all, memory, inputs({ now: T0 + SETTLE_MS })).aggregate, { state: 'waiting', task: 'ask: Needs approval' });
  });

  test('a session that is gone takes its memory with it', () => {
    const memory = newBoardMemory();
    buildBoard([session({ status: 'idle' })], memory, inputs());
    assert.equal(memory.idleSince.size, 1);
    buildBoard([], memory, inputs());
    assert.equal(memory.idleSince.size, 0);
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

describe('startClaudeSessions — reads real files, reports changes only', () => {
  test('a live session file becomes a card and drives the pet', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { startClaudeSessions } = await import('./claude-sessions.ts');

    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-claude-'));
    try {
      // this test process is a live pid, so the file is not treated as left behind by a crash
      writeFileSync(
        join(dir, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: 'cli-x',
          name: 'probe',
          status: 'busy',
          statusUpdatedAt: Date.now(),
          kind: 'interactive',
          hostSessionId: 'local_x',
        }),
      );
      const cards: unknown[] = [];
      const aggregates: unknown[] = [];
      const stop = startClaudeSessions({
        userRoot: dir,
        packageRoot: dir,
        lang: 'en',
        log: () => {},
        onCards: (c) => cards.push(c),
        onAggregate: (a) => aggregates.push(a),
        intervalMs: 20,
        sessionsDir: dir,
        appStoreDir: join(dir, 'no-app-store'),
        foreground: false,
      });
      await new Promise((r) => setTimeout(r, 120));
      stop();
      // several ticks ran, but nothing changed after the first: one report each
      assert.equal(cards.length, 1);
      assert.equal(aggregates.length, 1);
      assert.deepEqual(aggregates[0], { state: 'working', task: 'probe: Working' });
      assert.deepEqual(
        (cards[0] as { name: string; mood: string; link: string }[]).map((c) => [c.name, c.mood, c.link]),
        [['probe', 'working', 'claude://claude.ai/epitaxy/local_x']],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
