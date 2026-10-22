/**
 * The direct LSP lane at its two boundaries: the `LeanServerPool` service
 * (Effect, under `it.effect`'s `TestClock` where idle eviction and the
 * diagnostics quiet window are the subject, under `it.live` where the child
 * process's real exit timing is) and the `LeanLanguageServices` port the
 * `directLeanLanguageServices` layer provides — the pool's programs plus the
 * interruption fold, which the adapter suites compose directly under
 * `it.live`. Servers are a fake `lake` script (a real child process) or an
 * in-memory child handed to the Node spawner through the mocked `spawn`.
 */

// Node imports
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from '@effect/platform-node';
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Scope,
} from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const { spawnOverride } = vi.hoisted(() => ({
  spawnOverride: {
    current: undefined as undefined | ((...args: unknown[]) => unknown),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      (spawnOverride.current ?? actual.spawn)(...args),
  };
});

// Local imports
import type { RunId } from '@shared/schemas';
import {
  directLeanLanguageServices,
  type DirectLspLeanAdapterOptions,
} from '@texra/tools/lean/direct/directLspAdapter';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import { LeanServer } from '@texra/tools/lean/direct/leanServer';
import {
  LeanServerPool,
  type LeanServerPoolOptions,
} from '@texra/tools/lean/direct/leanServerPool';
import {
  createLeanServerRoster,
  isLeanServerActive,
  type LeanServerInfo,
} from '@texra/tools/lean/leanServerRegistry';

const FAKE_LAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const countPath = process.env.TEXRA_FAKE_LEAN_COUNT;

if (!process.argv.includes('--server')) {
  if (countPath) fs.appendFileSync(countPath, 'command\\n');
  const delayMs = Number(process.env.TEXRA_FAKE_LEAN_LAKE_DELAY || 0);
  setTimeout(() => process.exit(0), delayMs);
  return;
}

if (countPath) fs.appendFileSync(countPath, 'start\\n');

let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') {
    const delayMs = Number(process.env.TEXRA_FAKE_LEAN_EXIT_DELAY || 0);
    setTimeout(() => process.exit(0), delayMs);
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    if (process.env.TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS === '1') return;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [
          {
            severity: 1,
            message: 'fake diagnostic',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 }
            },
            source: 'fake-lean'
          }
        ]
      }
    });
    send({
      jsonrpc: '2.0',
      method: '$/lean/fileProgress',
      params: {
        textDocument: {
          uri: message.params.textDocument.uri,
          version: message.params.textDocument.version
        },
        processing: []
      }
    });
    if (countPath) fs.appendFileSync(countPath, 'diagnostics\\n');
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length: (\\d+)/i);
    if (!match) throw new Error('missing Content-Length');
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const frameEnd = bodyStart + length;
    if (buffer.length < frameEnd) return;
    const body = buffer.subarray(bodyStart, frameEnd).toString('utf8');
    buffer = buffer.subarray(frameEnd);
    handle(JSON.parse(body));
  }
});
`;

/** The `FileSystem`/`Path` pair the process runtime provides the spawner. */
const nodePlatform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** The spawner graph the process runtime serves the pool. */
const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(nodePlatform),
);

const NO_RUN: RunId | undefined = undefined;
const IDLE_HOUR = Duration.hours(1);

let tempRoot: string;
let projectRoot: string;
let fakeLakePath: string;
let countPath: string;
let filePath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'texra-direct-lsp-'));
  projectRoot = path.join(tempRoot, 'project');
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'lakefile.toml'), 'name = "Test"\n');
  filePath = path.join(projectRoot, 'Test.lean');
  writeFileSync(filePath, 'example : True := by trivial\n');
  fakeLakePath = path.join(tempRoot, 'fake-lake.js');
  writeFileSync(fakeLakePath, FAKE_LAKE);
  chmodSync(fakeLakePath, 0o755);
  countPath = path.join(tempRoot, 'events.txt');
  vi.stubEnv('TEXRA_FAKE_LEAN_COUNT', countPath);
  vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', undefined);
});

afterEach(() => {
  spawnOverride.current = undefined;
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
});

/** How many times the fake lake wrote `event`: 'start' (a server),
 *  'command' (a project command) or 'diagnostics' (sent to the client). */
async function countLogged(event: string): Promise<number> {
  const text = await readFile(countPath, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter((line) => line === event).length;
}

const logged = (event: string) => Effect.promise(() => countLogged(event));

const starts = logged('start');

/** A pool over the fake lake, disposed by the test scope unless disposed first. */
const openPool = (options: Partial<LeanServerPoolOptions> = {}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const pool = yield* Layer.build(
      LeanServerPool.layer({
        lakeCommand: fakeLakePath,
        idleTimeToLive: Duration.infinity,
        ...options,
      }).pipe(Layer.provide(spawnerLayer)),
    ).pipe(
      Scope.provide(scope),
      Effect.map((context) => Context.get(context, LeanServerPool)),
    );
    return { pool, dispose: Scope.close(scope, Exit.void) };
  });

/**
 * Run `effect` to its end, stepping the test clock only once the fake server
 * has sent this request's diagnostics. Until then the wait is real I/O (a
 * child process starting, which takes seconds under load) and the clock
 * stands still, so the handshake and diagnostics timeouts on it cannot fire;
 * after it, only the diagnostics quiet window is left to pass. A request on
 * an already-open file sends nothing and ends on its own. The clock leaves
 * its epoch first: the server reads a zero diagnostics stamp as none yet.
 */
const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust('1 millis');
    const before = yield* logged('diagnostics');
    const done = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      effect.pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
    );
    while (!(yield* Deferred.isDone(done))) {
      yield* Effect.promise(() => delay(10));
      if ((yield* logged('diagnostics')) > before)
        yield* TestClock.adjust('100 millis');
    }
    return yield* Fiber.join(fiber);
  });

// Waits on what a child does on its own (a handshake, an exit, a kill, a
// request received, a line the fake lake wrote): no Effect-side settle covers
// that.
const eventually = (assertion: () => void | Promise<void>) =>
  Effect.promise(() => vi.waitFor(assertion, { timeout: 5000, interval: 10 }));

const fakeLakeIt = {
  effect: it.effect.skipIf(process.platform === 'win32'),
  live: it.live.skipIf(process.platform === 'win32'),
};

describe('LeanServerPool', () => {
  fakeLakeIt.effect(
    'restarts by replacing the disposed server with a fresh process',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
        expect(yield* starts).toBe(1);

        yield* pool.executeProjectCommand('restart_server', NO_RUN);

        expect(yield* starts).toBe(2);
      }),
  );

  fakeLakeIt.effect('keeps more than two active workspaces by default', () =>
    Effect.gen(function* () {
      const second = makeLakeProject(tempRoot, 'project-b');
      const third = makeLakeProject(tempRoot, 'project-c');
      const { pool } = yield* openPool();
      yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
      yield* settle(pool.fetchDiagnosticsForFile(second.filePath, NO_RUN));
      yield* settle(pool.fetchDiagnosticsForFile(third.filePath, NO_RUN));
      expect(yield* starts).toBe(3);
      expect(activeServerRoots(pool)).toEqual([
        projectRoot,
        second.projectRoot,
        third.projectRoot,
      ]);
    }),
  );

  fakeLakeIt.effect('stops a workspace that sits idle for the idle time', () =>
    Effect.gen(function* () {
      const second = makeLakeProject(tempRoot, 'project-b');
      const { pool } = yield* openPool({ idleTimeToLive: IDLE_HOUR });
      yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
      expect(activeServerRoots(pool)).toEqual([projectRoot]);

      yield* TestClock.adjust('2 hours');
      yield* eventually(() => expect(activeServerRoots(pool)).toEqual([]));

      yield* settle(pool.fetchDiagnosticsForFile(second.filePath, NO_RUN));
      expect(yield* starts).toBe(2);
      expect(activeServerRoots(pool)).toEqual([second.projectRoot]);
    }),
  );

  fakeLakeIt.effect(
    'does not stop a server while a diagnostics request is in flight',
    () =>
      Effect.gen(function* () {
        vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
        const { pool, dispose } = yield* openPool({
          idleTimeToLive: Duration.seconds(1),
        });
        const pending = yield* Effect.forkChild(
          pool.fetchDiagnosticsForFile(filePath, NO_RUN),
        );
        yield* eventually(() =>
          expect(runningServerRoots(pool)).toEqual([projectRoot]),
        );

        // Well past the idle time, still inside the diagnostics wait: the
        // lease, not the clock, decides.
        yield* TestClock.adjust('5 seconds');
        expect(activeServerRoots(pool)).toEqual([projectRoot]);

        yield* dispose;
        expect(yield* Fiber.join(pending)).toMatchObject({
          ok: false,
          kind: 'toolchain_unavailable',
        });
        expect(activeServerRoots(pool)).toEqual([]);
      }),
  );

  fakeLakeIt.effect('does not start queued servers after dispose', () =>
    Effect.gen(function* () {
      const second = makeLakeProject(tempRoot, 'project-b');
      const third = makeLakeProject(tempRoot, 'project-c');
      const { pool, dispose } = yield* openPool();
      const pending = yield* Effect.forkChild(
        Effect.all(
          [filePath, second.filePath, third.filePath].map((file) =>
            Effect.exit(pool.fetchDiagnosticsForFile(file, NO_RUN)),
          ),
          { concurrency: 'unbounded' },
        ),
      );
      yield* dispose;
      yield* Fiber.await(pending);
      expect(activeServerRoots(pool)).toEqual([]);
      const started = yield* starts;
      yield* Effect.promise(() => delay(100));
      expect(yield* starts).toBe(started);
    }),
  );

  fakeLakeIt.effect(
    'does not SIGKILL a live server two seconds after spawn',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
        yield* TestClock.adjust('2200 millis');
        yield* Effect.promise(() => delay(50));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);
        expect(yield* starts).toBe(1);
        expect(
          yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN)),
        ).toMatchObject({ ok: true });
        expect(yield* starts).toBe(1);
      }),
  );

  it.effect(
    'reports a file still elaborating past the quiet window as incomplete, not clean',
    () =>
      Effect.gen(function* () {
        let child: FakeLeanChild | undefined;
        spawnOverride.current = () => {
          child = createFakeLeanChild({ elaborating: true });
          return child;
        };
        const { pool } = yield* openPool();
        yield* TestClock.adjust('1 millis');
        const done = yield* Deferred.make<void>();
        const pending = yield* Effect.forkChild(
          pool
            .fetchDiagnosticsForFile(filePath, NO_RUN)
            .pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
        );
        yield* eventually(() =>
          expect(child?.received).toContain('textDocument/didOpen'),
        );
        // Far past the quiet window after the empty diagnostics; the wait
        // ends only at its deadline, with the elaboration unfinished.
        while (!(yield* Deferred.isDone(done))) {
          yield* Effect.promise(() => delay(10));
          yield* TestClock.adjust('1 second');
        }
        expect(yield* Fiber.join(pending)).toEqual({
          ok: true,
          diagnostics: [],
          complete: false,
        });
      }),
  );

  it.live(
    'waits for the child to close before a failed start finishes releasing',
    () =>
      Effect.gen(function* () {
        // Killed, it closes only on `closeSoon`.
        const child = createFakeLeanChild({
          closeGate: new Promise<void>(() => {}),
          silent: true,
        });
        const spawned = yield* Deferred.make<void>();
        spawnOverride.current = () => {
          Deferred.doneUnsafe(spawned, Effect.void);
          return child;
        };
        const scope = yield* Scope.make();
        const build = yield* Effect.forkChild(
          Layer.build(
            LeanServer.layer({
              workspaceRoot: projectRoot,
              lakeCommand: fakeLakePath,
              roster: createLeanServerRoster(),
            }).pipe(Layer.provide(spawnerLayer)),
          ).pipe(Scope.provide(scope)),
        );
        yield* Deferred.await(spawned);
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        const finished = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          Fiber.await(closing).pipe(
            Effect.andThen(Deferred.succeed(finished, undefined)),
          ),
        );
        yield* Effect.promise(() => delay(30));
        expect(yield* Deferred.isDone(finished)).toBe(false);
        child.closeSoon();
        yield* Fiber.join(closing);
        yield* Fiber.await(build);
        expect(yield* Deferred.isDone(finished)).toBe(true);
      }),
  );

  it.live(
    'retries EMFILE after evicting idle servers without waiting for busy ones',
    () =>
      Effect.gen(function* () {
        const second = makeLakeProject(tempRoot, 'project-b');
        const third = makeLakeProject(tempRoot, 'project-c');
        let spawnCount = 0;
        let failNextSpawn = false;
        let first: FakeLeanChild | undefined;
        spawnOverride.current = () => {
          spawnCount += 1;
          if (failNextSpawn) {
            failNextSpawn = false;
            // Node reports EMFILE through the child's `error` event, not a throw.
            return createFailedSpawnChild('EMFILE');
          }
          const child = createFakeLeanChild();
          first ??= child;
          return child;
        };

        const { pool, dispose } = yield* openPool();
        yield* pool.fetchDiagnosticsForFile(filePath, NO_RUN);
        yield* pool.fetchDiagnosticsForFile(second.filePath, NO_RUN);

        // Keep the first workspace in flight so recovery cannot evict it.
        const pendingBusy = yield* Effect.forkChild(
          pool.positionRequest(filePath, 0, 0, 'textDocument/hover', NO_RUN),
        );
        yield* eventually(() =>
          expect(first?.received).toContain('textDocument/hover'),
        );

        failNextSpawn = true;
        const started = yield* pool
          .fetchDiagnosticsForFile(third.filePath, NO_RUN)
          .pipe(
            // The hover is never answered: waiting for it would hang.
            Effect.timeoutOrElse({
              duration: '5 seconds',
              orElse: () =>
                Effect.die(
                  new Error('EMFILE recovery waited for the busy session'),
                ),
            }),
          );
        expect(started).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(activeServerRoots(pool)).toEqual([
          projectRoot,
          third.projectRoot,
        ]);
        expect(spawnCount).toBe(4);
        yield* dispose;
        yield* Fiber.await(pendingBusy);
      }),
  );

  it.live('awaits already-closing servers before retrying EMFILE', () =>
    Effect.gen(function* () {
      const second = makeLakeProject(tempRoot, 'project-b');
      let spawnCount = 0;
      let firstClosed = false;
      // The idle first server closes only once the pool has entered EMFILE
      // recovery (its warning), so the retry finds it closing, not closed.
      const firstClose = Promise.withResolvers<void>();
      const recovering = Logger.make(({ message }) => {
        if (String(message).includes('Lean spawn hit a full file table'))
          firstClose.resolve();
      });
      const first = createFakeLeanChild({ closeGate: firstClose.promise });
      first.on('close', () => {
        firstClosed = true;
      });
      spawnOverride.current = () => {
        spawnCount += 1;
        if (spawnCount === 1) return first;
        if (!firstClosed) return createFailedSpawnChild('EMFILE');
        return createFakeLeanChild();
      };

      const { pool } = yield* openPool({
        idleTimeToLive: Duration.millis(30),
      });
      yield* pool.fetchDiagnosticsForFile(filePath, NO_RUN);
      yield* eventually(() => expect(first.killed).toBe(true));
      const started = yield* pool
        .fetchDiagnosticsForFile(second.filePath, NO_RUN)
        .pipe(
          Effect.withLogger(recovering),
          // A retry that never awaits the close would hang.
          Effect.timeoutOrElse({
            duration: '5 seconds',
            orElse: () =>
              Effect.die(
                new Error(
                  'EMFILE recovery did not wait for the closing server',
                ),
              ),
          }),
        );
      expect(started).toMatchObject({
        ok: true,
        diagnostics: [{ message: 'fake diagnostic' }],
      });
      expect(firstClosed).toBe(true);
      expect(spawnCount).toBe(3);
    }),
  );

  it.live('keeps a closing server reserved until the child closes', () =>
    Effect.gen(function* () {
      const close = Promise.withResolvers<void>();
      const children: FakeLeanChild[] = [];
      spawnOverride.current = () => {
        children.push(createFakeLeanChild({ closeGate: close.promise }));
        return children.at(-1);
      };
      const { pool } = yield* openPool({
        idleTimeToLive: Duration.millis(30),
      });
      yield* pool.fetchDiagnosticsForFile(filePath, NO_RUN);
      expect(children).toHaveLength(1);
      yield* eventually(() => expect(children[0]?.killed).toBe(true));
      const pending = yield* Effect.forkChild(
        pool.fetchDiagnosticsForFile(filePath, NO_RUN),
      );
      yield* Effect.promise(() => delay(40));
      expect(children).toHaveLength(1);
      close.resolve();
      yield* Fiber.join(pending);
      expect(children).toHaveLength(2);
    }),
  );

  fakeLakeIt.effect('stops a restarted server after it sits idle', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool({ idleTimeToLive: IDLE_HOUR });
      yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
      yield* pool.executeProjectCommand('restart_server', NO_RUN);
      expect(activeServerRoots(pool)).toEqual([projectRoot]);
      yield* TestClock.adjust('2 hours');
      yield* eventually(() => expect(activeServerRoots(pool)).toEqual([]));
    }),
  );

  fakeLakeIt.effect('treats project commands as server activity', () =>
    Effect.gen(function* () {
      const second = makeLakeProject(tempRoot, 'project-b');
      const { pool } = yield* openPool({ idleTimeToLive: IDLE_HOUR });
      yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
      yield* TestClock.adjust('30 minutes');
      yield* pool.executeProjectCommand('build', NO_RUN);
      yield* TestClock.adjust('45 minutes');
      yield* settle(pool.fetchDiagnosticsForFile(second.filePath, NO_RUN));
      expect(activeServerRoots(pool)).toEqual([
        projectRoot,
        second.projectRoot,
      ]);
    }),
  );

  // Idle eviction is off in the run-end tests below (infinite idle time), so
  // the run-end stop is the only mechanism that can remove a server.
  fakeLakeIt.live('stops the server when the run that started it ends', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool();
      yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
      expect(activeServerRoots(pool)).toEqual([projectRoot]);

      yield* pool.stopSessionsForRun(run('e00001'));

      expect(activeServerRoots(pool)).toEqual([]);
      expect(yield* starts).toBe(1);
    }),
  );

  fakeLakeIt.effect(
    'keeps servers started by other runs or outside a run when a run ends',
    () =>
      Effect.gen(function* () {
        const second = makeLakeProject(tempRoot, 'project-b');
        const third = makeLakeProject(tempRoot, 'project-c');
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
        yield* settle(
          pool.fetchDiagnosticsForFile(second.filePath, run('e00002')),
        );
        yield* settle(pool.fetchDiagnosticsForFile(third.filePath, NO_RUN));
        expect(activeServerRoots(pool)).toEqual([
          projectRoot,
          second.projectRoot,
          third.projectRoot,
        ]);

        yield* pool.stopSessionsForRun(run('e00001'));

        expect(activeServerRoots(pool)).toEqual([
          second.projectRoot,
          third.projectRoot,
        ]);
      }),
  );

  fakeLakeIt.effect(
    'stops a shared server after its final owner and lease end',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '1500');
        const build = yield* Effect.forkChild(
          pool.executeProjectCommand('build', run('e00001')),
        );
        // Running, so its lease is held.
        yield* eventually(async () =>
          expect(await countLogged('command')).toBe(1),
        );
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00002')));

        // The reuser joins the original owner. Ending only e00002 keeps the
        // shared server for e00001; ending the final owner defers the stop
        // until e00001's already-running build releases its lease.
        yield* pool.stopSessionsForRun(run('e00002'));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);
        yield* pool.stopSessionsForRun(run('e00001'));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);

        yield* Fiber.join(build);
        expect(activeServerRoots(pool)).toEqual([]);
      }),
  );

  fakeLakeIt.effect(
    'cancels a deferred stop when a later run takes ownership',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '1500');
        const build = yield* Effect.forkChild(
          pool.executeProjectCommand('build', run('e00001')),
        );
        // Running, so its lease is held.
        yield* eventually(async () =>
          expect(await countLogged('command')).toBe(1),
        );
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00002')));
        yield* pool.stopSessionsForRun(run('e00001'));
        yield* pool.stopSessionsForRun(run('e00002'));

        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00003')));
        yield* Fiber.join(build);
        expect(activeServerRoots(pool)).toEqual([projectRoot]);

        yield* pool.stopSessionsForRun(run('e00003'));
        expect(activeServerRoots(pool)).toEqual([]);
      }),
  );

  fakeLakeIt.effect('adds a project-command run as a server owner', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool();
      yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
      yield* pool.executeProjectCommand('build', run('e00002'));

      yield* pool.stopSessionsForRun(run('e00001'));
      expect(activeServerRoots(pool)).toEqual([projectRoot]);

      yield* pool.stopSessionsForRun(run('e00002'));
      expect(activeServerRoots(pool)).toEqual([]);
    }),
  );

  fakeLakeIt.effect(
    "keeps a parent's reused server until both parent and subagent end",
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00002')));
        expect(yield* starts).toBe(1);

        // A subagent joins the parent as an owner; either run ending alone
        // leaves the shared-worktree server available to the other.
        yield* pool.stopSessionsForRun(run('e00001'));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);

        yield* pool.stopSessionsForRun(run('e00002'));
        expect(activeServerRoots(pool)).toEqual([]);
      }),
  );

  it.live('records an owner before its server is ready', () =>
    Effect.gen(function* () {
      let releaseInitialize!: () => void;
      const initializeGate = new Promise<void>((resolve) => {
        releaseInitialize = resolve;
      });
      let spawnCount = 0;
      const spawned = yield* Deferred.make<void>();
      spawnOverride.current = () => {
        spawnCount += 1;
        Deferred.doneUnsafe(spawned, Effect.void);
        return createFakeLeanChild({ initializeGate });
      };
      const { pool } = yield* openPool();
      // Hold the handshake open: the owner must be recorded before the wait
      // for readiness, so a run end that lands meanwhile sees it and defers
      // the stop to the end of this request's lease.
      const request = yield* Effect.forkChild(
        pool.fetchDiagnosticsForFile(filePath, run('e00002')),
      );
      yield* Deferred.await(spawned);
      expect(spawnCount).toBe(1);
      yield* pool.stopSessionsForRun(run('e00002'));
      expect(activeServerRoots(pool)).toEqual([projectRoot]);

      releaseInitialize();
      expect(yield* Fiber.join(request)).toMatchObject({ ok: true });
      expect(activeServerRoots(pool)).toEqual([]);
    }),
  );

  fakeLakeIt.effect(
    'reattributes a restarted server to the restarting run',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
        yield* pool.executeProjectCommand('restart_server', run('e00002'));
        expect(yield* starts).toBe(2);

        // The replacement process was started by e00002, so e00001's end must
        // leave it alone and e00002's end must stop it.
        yield* pool.stopSessionsForRun(run('e00001'));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);

        yield* pool.stopSessionsForRun(run('e00002'));
        expect(activeServerRoots(pool)).toEqual([]);
      }),
  );
});

describe('directLeanLanguageServices', () => {
  const fakeLakeIt = it.live.skipIf(process.platform === 'win32');

  /**
   * The port methods are programs; these tests compose them directly, the
   * way a tool's execute() does after its one boundary run. The layer is
   * built into a scope of its own, closed by the test scope unless a test
   * closes it first — the runtime disposal a host performs.
   */
  const openAdapter = (options: DirectLspLeanAdapterOptions) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const adapter = yield* Layer.build(
        directLeanLanguageServices(options).pipe(
          Layer.provide(Layer.mergeAll(nodePlatform, spawnerLayer)),
        ),
      ).pipe(
        Scope.provide(scope),
        Effect.map((context) => Context.get(context, LeanLanguageServices)),
      );
      return { adapter, dispose: Scope.close(scope, Exit.void) };
    });

  fakeLakeIt(
    'joins concurrent first-touch requests for the same workspace',
    () =>
      Effect.gen(function* () {
        const { adapter } = yield* openAdapter({ lakeCommand: fakeLakePath });
        const [first, second] = yield* Effect.all(
          [
            adapter.fetchDiagnosticsForFile(filePath),
            adapter.fetchDiagnosticsForFile(filePath),
          ],
          { concurrency: 'unbounded' },
        );

        expect(first).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(second).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(yield* starts).toBe(1);
      }),
  );

  fakeLakeIt('attributes a request to its explicitly supplied agent run', () =>
    Effect.gen(function* () {
      const { adapter } = yield* openAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      yield* adapter.fetchDiagnosticsForFile(filePath, run('e00001'));
      expect(activeServerRoots(adapter)).toEqual([projectRoot]);

      yield* adapter.stopSessionsForRun?.(run('e00001')) ?? Effect.void;

      expect(activeServerRoots(adapter)).toEqual([]);
    }),
  );

  it.live(
    'reports a missing lake command as toolchain_unavailable, not "file missing"',
    () =>
      Effect.gen(function* () {
        const { adapter } = yield* openAdapter({
          lakeCommand: path.join(tempRoot, 'missing-lake'),
        });
        const result = yield* adapter.fetchDiagnosticsForFile(filePath);
        expect(result).toMatchObject({
          ok: false,
          kind: 'toolchain_unavailable',
        });
      }),
  );

  fakeLakeIt(
    'reports requests a dispose interrupted mid-start as stopped',
    () =>
      Effect.gen(function* () {
        const { adapter, dispose } = yield* openAdapter({
          lakeCommand: fakeLakePath,
        });
        let spawnCount = 0;
        const spawned = yield* Deferred.make<void>();
        // The handshake never answers, so every request below is still
        // waiting on the server's build when the dispose closes the scope
        // under it. The interruption that follows is not a failure the pool
        // can fold, so the methods stay total only if the port's own fold
        // recovers it.
        spawnOverride.current = () => {
          spawnCount += 1;
          Deferred.doneUnsafe(spawned, Effect.void);
          return createFakeLeanChild({
            initializeGate: new Promise<void>(() => {}),
          });
        };
        const diagnostics = yield* Effect.forkChild(
          adapter.fetchDiagnosticsForFile(filePath),
        );
        const fileCommand = yield* Effect.forkChild(
          adapter.executeFileCommand('restart', filePath),
        );
        const hover = yield* Effect.forkChild(
          adapter.getHoverInfo(filePath, 0, 0),
        );
        yield* Deferred.await(spawned);
        expect(spawnCount).toBe(1);

        yield* dispose;

        expect(yield* Fiber.join(diagnostics)).toEqual({
          ok: false,
          kind: 'toolchain_unavailable',
          message: 'Lean adapter was stopped.',
        });
        expect(yield* Effect.flip(Fiber.join(fileCommand))).toMatchObject({
          _tag: 'LeanFileCommandFailed',
          reason: 'failed',
          message: 'Lean adapter was stopped.',
        });
        expect(yield* Fiber.join(hover)).toEqual({
          data: null,
          error: 'Lean adapter was stopped.',
        });
      }),
  );

  fakeLakeIt('stops every server when disposed, and disposes twice', () =>
    Effect.gen(function* () {
      const { adapter, dispose } = yield* openAdapter({
        lakeCommand: fakeLakePath,
      });
      yield* adapter.fetchDiagnosticsForFile(filePath);
      expect(activeServerRoots(adapter)).toEqual([projectRoot]);

      yield* dispose;
      expect(activeServerRoots(adapter)).toEqual([]);

      yield* dispose;
      const after = yield* adapter.fetchDiagnosticsForFile(filePath);
      expect(after).toMatchObject({
        ok: false,
        kind: 'toolchain_unavailable',
        message: 'Lean adapter was stopped.',
      });
    }),
  );
});

function run(runId: string): RunId {
  return runId as RunId;
}

function makeLakeProject(
  root: string,
  name: string,
): { projectRoot: string; filePath: string } {
  const projectRoot = path.join(root, name);
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'lakefile.toml'), `name = "${name}"\n`);
  const filePath = path.join(projectRoot, 'Test.lean');
  writeFileSync(filePath, 'example : True := by trivial\n');
  return { projectRoot, filePath };
}

/** The roster the pool or the port over it reports. */
interface ServerRosterReader {
  listServers(): readonly LeanServerInfo[];
}

function runningServerRoots(reader: ServerRosterReader): string[] {
  return reader
    .listServers()
    .filter((info) => info.status === 'running')
    .map((info) => info.workspaceRoot);
}

function activeServerRoots(reader: ServerRosterReader): string[] {
  return reader
    .listServers()
    .filter(isLeanServerActive)
    .map((info) => info.workspaceRoot)
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Above every real pid, so the spawner's process-group probe and group kill
 * (`process.kill(-pid, ...)`) fail with ESRCH and fall back to the fake's own
 * `kill` instead of signalling an unrelated group on the test machine.
 */
const FAKE_PID = 2_147_483_646;

interface FakeLeanChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  closeSoon: () => void;
  /** The methods the client sent, in order. */
  received: readonly string[];
}

/**
 * What `spawn` returns when the process could not be created: no stdio, an
 * `error` on the next tick carrying the errno, then `close`, as Node does.
 */
function createFailedSpawnChild(code: 'EMFILE' | 'ENFILE'): EventEmitter {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid: undefined,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => false,
  });
  process.nextTick(() => {
    child.exitCode = -24;
    child.emit(
      'error',
      Object.assign(new Error(`spawn lake ${code}`), { code }),
    );
    child.emit('close', -24, null);
  });
  return child;
}

function createFakeLeanChild(options?: {
  /** Once killed, close only when this settles (else at once). */
  closeGate?: Promise<void>;
  silent?: boolean;
  /** Answer `initialize` only once this settles. */
  initializeGate?: Promise<void>;
  /** Report every opened file as still elaborating, with no diagnostics yet. */
  elaborating?: boolean;
}): FakeLeanChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = Buffer.alloc(0);
  const received: string[] = [];

  function send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdout.write(body);
  }

  function handle(message: {
    id?: number;
    method?: string;
    params?: { textDocument?: { uri?: string; version?: number } };
  }): void {
    if (message.method) received.push(message.method);
    if (message.method === 'initialize') {
      if (options?.silent) return;
      const reply = () =>
        send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      if (options?.initializeGate) void options.initializeGate.then(reply);
      else reply();
      return;
    }
    if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    }
    if (message.method === 'textDocument/didOpen') {
      const uri = message.params?.textDocument?.uri;
      if (!uri) return;
      const progress = (processing: unknown[]) =>
        send({
          jsonrpc: '2.0',
          method: '$/lean/fileProgress',
          params: {
            textDocument: {
              uri,
              version: message.params?.textDocument?.version,
            },
            processing,
          },
        });
      if (options?.elaborating) {
        const range = {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
        };
        progress([{ range, kind: 1 }]);
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: { uri, diagnostics: [] },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              severity: 1,
              message: 'fake diagnostic',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              source: 'fake-lean',
            },
          ],
        },
      });
      progress([]);
    }
  }

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) return;
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const frameEnd = bodyStart + length;
      if (buffer.length < frameEnd) return;
      const body = buffer.subarray(bodyStart, frameEnd).toString('utf8');
      buffer = buffer.subarray(frameEnd);
      handle(JSON.parse(body) as Parameters<typeof handle>[0]);
    }
  });

  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    pid: FAKE_PID,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    emit: events.emit.bind(events),
    kill(signal?: NodeJS.Signals) {
      if (this.killed || this.exitCode != null || this.signalCode != null)
        return true;
      this.killed = true;
      // A signalled child keeps running until it dies: `exit` and the stdio
      // `close` that follows it both land after the gate, as Node's do.
      const finish = () => {
        this.exitCode = 0;
        this.emit('exit', 0, signal ?? null);
        if (!stdin.destroyed) stdin.end();
        if (!stdout.destroyed) stdout.end();
        if (!stderr.destroyed) stderr.end();
        this.emit('close', 0, null);
      };
      if (options?.closeGate) void options.closeGate.then(finish);
      else finish();
      return true;
    },
    closeSoon() {
      this.exitCode = 1;
      this.emit('exit', 1, null);
      this.emit('close', 1, null);
    },
    received,
    unref() {},
    ref() {},
  });
  // Node emits `spawn` once the child is running, on a later tick than the
  // `spawn()` call that attaches the listener. A fake may be built before the
  // call that hands it out, so the emit hangs off the listener's arrival
  // rather than off this constructor.
  const emitSpawn = (event: string) => {
    if (event !== 'spawn') return;
    child.off('newListener', emitSpawn);
    process.nextTick(() => child.emit('spawn'));
  };
  child.on('newListener', emitSpawn);
  return child;
}
