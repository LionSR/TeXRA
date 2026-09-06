/**
 * The direct LSP lane at its two boundaries: the `LeanServerPool` service
 * (Effect, under `it.effect`'s `TestClock` where idle eviction and the
 * diagnostics quiet window are the subject, under `it.live` where the child
 * process's real exit timing is) and the Promise edge
 * `createDirectLspLeanAdapter` returns. Servers are a fake `lake` script
 * (a real child process) or an in-memory child handed to the Node spawner
 * through the mocked `spawn`.
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

// Third-party imports
import { it } from '@effect/vitest';
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
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
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { nodeChildProcessSpawnerLayer } from '@platform/defaults/nodeChildProcessSpawner';
import type { ExecutionId } from '@shared/schemas';
import { createDirectLspLeanAdapter } from '@tools/lean/direct/directLspAdapter';
import { LeanServer } from '@tools/lean/direct/leanServer';
import {
  LeanServerPool,
  type LeanServerPoolOptions,
} from '@tools/lean/direct/leanServerPool';
import {
  isLeanServerActive,
  listLeanServers,
  unregisterLeanServer,
} from '@tools/lean/leanServerRegistry';
import { delay } from '@utils/core';
import { splitOutputLines } from '@utils/text/stringUtils';

const FAKE_LAKE = `#!/usr/bin/env node
const fs = require('node:fs');

if (!process.argv.includes('--server')) {
  const delayMs = Number(process.env.TEXRA_FAKE_LEAN_LAKE_DELAY || 0);
  setTimeout(() => process.exit(0), delayMs);
  return;
}

const countPath = process.env.TEXRA_FAKE_LEAN_COUNT;
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

const NO_RUN: ExecutionId | undefined = undefined;
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
  countPath = path.join(tempRoot, 'starts.txt');
  vi.stubEnv('TEXRA_FAKE_LEAN_COUNT', countPath);
  vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', undefined);
});

afterEach(() => {
  spawnOverride.current = undefined;
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
  // The registry is process-global and ids are per server instance: a test
  // that failed mid-way must not leave its entries for the next one.
  for (const server of listLeanServers()) unregisterLeanServer(server.id);
});

async function countStarts(): Promise<number> {
  const text = await readFile(countPath, 'utf8').catch(() => '');
  return splitOutputLines(text).length;
}

const starts = Effect.promise(countStarts);

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
      }).pipe(Layer.provide(nodeChildProcessSpawnerLayer)),
    ).pipe(
      Scope.provide(scope),
      Effect.map((context) => Context.get(context, LeanServerPool)),
    );
    return { pool, dispose: Scope.close(scope, Exit.void) };
  });

/**
 * Run `effect` while stepping the test clock until it settles. The server's
 * replies arrive on real I/O; only the diagnostics quiet window is on the
 * clock, so each step is a fraction of it and the overshoot stays far below
 * the hour-long idle times the tests use.
 */
const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      effect.pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
    );
    while (!(yield* Deferred.isDone(done))) {
      yield* Effect.promise(() => delay(5));
      yield* TestClock.adjust('100 millis');
    }
    return yield* Fiber.join(fiber);
  });

const eventually = (assertion: () => void) =>
  Effect.promise(() => vi.waitFor(assertion, { timeout: 3000, interval: 10 }));

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
      expect(activeServerRoots()).toEqual([
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
      expect(activeServerRoots()).toEqual([projectRoot]);

      yield* TestClock.adjust('2 hours');
      yield* eventually(() => expect(activeServerRoots()).toEqual([]));

      yield* settle(pool.fetchDiagnosticsForFile(second.filePath, NO_RUN));
      expect(yield* starts).toBe(2);
      expect(activeServerRoots()).toEqual([second.projectRoot]);
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
          expect(runningServerRoots()).toEqual([projectRoot]),
        );

        // Well past the idle time, still inside the diagnostics wait: the
        // lease, not the clock, decides.
        yield* TestClock.adjust('5 seconds');
        expect(activeServerRoots()).toEqual([projectRoot]);

        yield* dispose;
        expect(yield* Fiber.join(pending)).toMatchObject({
          ok: false,
          kind: 'toolchain_unavailable',
        });
        expect(activeServerRoots()).toEqual([]);
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
      expect(activeServerRoots()).toEqual([]);
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
        expect(activeServerRoots()).toEqual([projectRoot]);
        expect(yield* starts).toBe(1);
        expect(
          yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN)),
        ).toMatchObject({ ok: true });
        expect(yield* starts).toBe(1);
      }),
  );

  it.live(
    'waits for the child to close before a failed start finishes releasing',
    () =>
      Effect.gen(function* () {
        const child = createFakeLeanChild({ closeDelayMs: 80, silent: true });
        spawnOverride.current = () => child;
        const scope = yield* Scope.make();
        const build = yield* Effect.forkChild(
          Layer.build(
            LeanServer.layer({
              workspaceRoot: projectRoot,
              lakeCommand: fakeLakePath,
            }).pipe(Layer.provide(nodeChildProcessSpawnerLayer)),
          ).pipe(Scope.provide(scope)),
        );
        yield* Effect.promise(() => delay(20));
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
        spawnOverride.current = () => {
          spawnCount += 1;
          if (failNextSpawn) {
            failNextSpawn = false;
            // Node reports EMFILE through the child's `error` event, not a throw.
            return createFailedSpawnChild('EMFILE');
          }
          return createFakeLeanChild();
        };

        const { pool, dispose } = yield* openPool();
        yield* pool.fetchDiagnosticsForFile(filePath, NO_RUN);
        yield* pool.fetchDiagnosticsForFile(second.filePath, NO_RUN);

        // Keep the first workspace in flight so recovery cannot evict it.
        const pendingBusy = yield* Effect.forkChild(
          pool.positionRequest(filePath, 0, 0, 'textDocument/hover', NO_RUN),
        );
        yield* Effect.promise(() => delay(50));

        failNextSpawn = true;
        const started = yield* pool
          .fetchDiagnosticsForFile(third.filePath, NO_RUN)
          .pipe(
            Effect.timeoutOrElse({
              duration: '1 second',
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
        expect(activeServerRoots()).toEqual([projectRoot, third.projectRoot]);
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
      spawnOverride.current = () => {
        spawnCount += 1;
        if (spawnCount > 1 && !firstClosed) {
          throw Object.assign(new Error('too many open files'), {
            code: 'EMFILE',
          });
        }
        const child = createFakeLeanChild({
          closeDelayMs: spawnCount === 1 ? 200 : 0,
        });
        if (spawnCount === 1) {
          child.on('close', () => {
            firstClosed = true;
          });
        }
        return child;
      };

      const { pool } = yield* openPool({
        idleTimeToLive: Duration.millis(30),
      });
      yield* pool.fetchDiagnosticsForFile(filePath, NO_RUN);
      yield* Effect.promise(() => delay(80));
      const started = yield* pool
        .fetchDiagnosticsForFile(second.filePath, NO_RUN)
        .pipe(
          Effect.timeoutOrElse({
            duration: '1 second',
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
      let spawnCount = 0;
      spawnOverride.current = () => {
        spawnCount += 1;
        return createFakeLeanChild({ closeDelayMs: 200 });
      };
      const { pool } = yield* openPool({
        idleTimeToLive: Duration.millis(30),
      });
      yield* pool.fetchDiagnosticsForFile(filePath, NO_RUN);
      expect(spawnCount).toBe(1);
      yield* Effect.promise(() => delay(60));
      const pending = yield* Effect.forkChild(
        pool.fetchDiagnosticsForFile(filePath, NO_RUN),
      );
      yield* Effect.promise(() => delay(40));
      expect(spawnCount).toBe(1);
      yield* Fiber.join(pending);
      expect(spawnCount).toBe(2);
    }),
  );

  fakeLakeIt.effect('stops a restarted server after it sits idle', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool({ idleTimeToLive: IDLE_HOUR });
      yield* settle(pool.fetchDiagnosticsForFile(filePath, NO_RUN));
      yield* pool.executeProjectCommand('restart_server', NO_RUN);
      expect(activeServerRoots()).toEqual([projectRoot]);
      yield* TestClock.adjust('2 hours');
      yield* eventually(() => expect(activeServerRoots()).toEqual([]));
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
      expect(activeServerRoots()).toEqual([projectRoot, second.projectRoot]);
    }),
  );

  // Idle eviction is off in the run-end tests below (infinite idle time), so
  // the run-end stop is the only mechanism that can remove a server.
  fakeLakeIt.live('stops the server when the run that started it ends', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool();
      yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
      expect(activeServerRoots()).toEqual([projectRoot]);

      yield* pool.stopSessionsForRun(run('e00001'));

      expect(activeServerRoots()).toEqual([]);
      expect(yield* starts).toBe(1);
    }),
  );

  fakeLakeIt.live(
    'keeps servers started by other runs or outside a run when a run ends',
    () =>
      Effect.gen(function* () {
        const second = makeLakeProject(tempRoot, 'project-b');
        const third = makeLakeProject(tempRoot, 'project-c');
        const { pool } = yield* openPool();
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
        yield* pool.fetchDiagnosticsForFile(second.filePath, run('e00002'));
        yield* pool.fetchDiagnosticsForFile(third.filePath, NO_RUN);
        expect(activeServerRoots()).toEqual([
          projectRoot,
          second.projectRoot,
          third.projectRoot,
        ]);

        yield* pool.stopSessionsForRun(run('e00001'));

        expect(activeServerRoots()).toEqual([
          second.projectRoot,
          third.projectRoot,
        ]);
      }),
  );

  fakeLakeIt.live(
    'stops a shared server after its final owner and lease end',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
        expect(activeServerRoots()).toEqual([projectRoot]);
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '1500');
        const build = yield* Effect.forkChild(
          pool.executeProjectCommand('build', run('e00001')),
        );
        yield* Effect.promise(() => delay(50));
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00002'));

        // The reuser joins the original owner. Ending only e00002 keeps the
        // shared server for e00001; ending the final owner defers the stop
        // until e00001's already-running build releases its lease.
        yield* pool.stopSessionsForRun(run('e00002'));
        expect(activeServerRoots()).toEqual([projectRoot]);
        yield* pool.stopSessionsForRun(run('e00001'));
        expect(activeServerRoots()).toEqual([projectRoot]);

        yield* Fiber.join(build);
        expect(activeServerRoots()).toEqual([]);
      }),
  );

  fakeLakeIt.live(
    'cancels a deferred stop when a later run takes ownership',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '1500');
        const build = yield* Effect.forkChild(
          pool.executeProjectCommand('build', run('e00001')),
        );
        yield* Effect.promise(() => delay(50));
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00002'));
        yield* pool.stopSessionsForRun(run('e00001'));
        yield* pool.stopSessionsForRun(run('e00002'));

        yield* pool.fetchDiagnosticsForFile(filePath, run('e00003'));
        yield* Fiber.join(build);
        expect(activeServerRoots()).toEqual([projectRoot]);

        yield* pool.stopSessionsForRun(run('e00003'));
        expect(activeServerRoots()).toEqual([]);
      }),
  );

  fakeLakeIt.live('adds a project-command run as a server owner', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool();
      yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
      yield* pool.executeProjectCommand('build', run('e00002'));

      yield* pool.stopSessionsForRun(run('e00001'));
      expect(activeServerRoots()).toEqual([projectRoot]);

      yield* pool.stopSessionsForRun(run('e00002'));
      expect(activeServerRoots()).toEqual([]);
    }),
  );

  fakeLakeIt.live(
    "keeps a parent's reused server until both parent and subagent end",
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
        yield* pool.fetchDiagnosticsForFile(filePath, run('e00002'));
        expect(yield* starts).toBe(1);

        // A subagent joins the parent as an owner; either run ending alone
        // leaves the shared-worktree server available to the other.
        yield* pool.stopSessionsForRun(run('e00001'));
        expect(activeServerRoots()).toEqual([projectRoot]);

        yield* pool.stopSessionsForRun(run('e00002'));
        expect(activeServerRoots()).toEqual([]);
      }),
  );

  it.live('records an owner before its server is ready', () =>
    Effect.gen(function* () {
      let releaseInitialize!: () => void;
      const initializeGate = new Promise<void>((resolve) => {
        releaseInitialize = resolve;
      });
      let spawnCount = 0;
      spawnOverride.current = () => {
        spawnCount += 1;
        return createFakeLeanChild({ initializeGate });
      };
      const { pool } = yield* openPool();
      // Hold the handshake open: the owner must be recorded before the wait
      // for readiness, so a run end that lands meanwhile sees it and defers
      // the stop to the end of this request's lease.
      const request = yield* Effect.forkChild(
        pool.fetchDiagnosticsForFile(filePath, run('e00002')),
      );
      yield* eventually(() => expect(spawnCount).toBe(1));
      yield* pool.stopSessionsForRun(run('e00002'));
      expect(activeServerRoots()).toEqual([projectRoot]);

      releaseInitialize();
      expect(yield* Fiber.join(request)).toMatchObject({ ok: true });
      expect(activeServerRoots()).toEqual([]);
    }),
  );

  fakeLakeIt.live('reattributes a restarted server to the restarting run', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool();
      yield* pool.fetchDiagnosticsForFile(filePath, run('e00001'));
      yield* pool.executeProjectCommand('restart_server', run('e00002'));
      expect(yield* starts).toBe(2);

      // The replacement process was started by e00002, so e00001's end must
      // leave it alone and e00002's end must stop it.
      yield* pool.stopSessionsForRun(run('e00001'));
      expect(activeServerRoots()).toEqual([projectRoot]);

      yield* pool.stopSessionsForRun(run('e00002'));
      expect(activeServerRoots()).toEqual([]);
    }),
  );
});

describe('createDirectLspLeanAdapter', () => {
  const fakeLakeIt = it.skipIf(process.platform === 'win32');

  fakeLakeIt(
    'joins concurrent first-touch requests for the same workspace',
    async () => {
      const adapter = createDirectLspLeanAdapter({ lakeCommand: fakeLakePath });
      try {
        const [first, second] = await Promise.all([
          adapter.fetchDiagnosticsForFile(filePath),
          adapter.fetchDiagnosticsForFile(filePath),
        ]);

        expect(first).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(second).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(await countStarts()).toBe(1);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt('attributes a request to the ambient agent run', async () => {
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 0,
    });
    try {
      await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
      expect(activeServerRoots()).toEqual([projectRoot]);

      await adapter.stopSessionsForRun?.('e00001' as ExecutionId);

      expect(activeServerRoots()).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  it('reports a missing lake command as toolchain_unavailable, not "file missing"', async () => {
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: path.join(tempRoot, 'missing-lake'),
    });
    try {
      await expect(
        adapter.fetchDiagnosticsForFile(filePath),
      ).resolves.toMatchObject({ ok: false, kind: 'toolchain_unavailable' });
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt(
    'stops every server when disposed, and disposes twice',
    async () => {
      const adapter = createDirectLspLeanAdapter({ lakeCommand: fakeLakePath });
      await adapter.fetchDiagnosticsForFile(filePath);
      expect(activeServerRoots()).toEqual([projectRoot]);

      await adapter.dispose();
      expect(activeServerRoots()).toEqual([]);

      await adapter.dispose();
      await expect(
        adapter.fetchDiagnosticsForFile(filePath),
      ).resolves.toMatchObject({
        ok: false,
        kind: 'toolchain_unavailable',
        message: 'Lean adapter was stopped.',
      });
    },
  );
});

function run(executionId: string): ExecutionId {
  return executionId as ExecutionId;
}

/** Run `fn` with the ambient run context of the given agent run. */
function asRun<T>(
  executionId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return withRunContext(createRunContext({ executionId }), fn);
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

function runningServerRoots(): string[] {
  return listLeanServers()
    .filter((info) => info.status === 'running')
    .map((info) => info.workspaceRoot);
}

function activeServerRoots(): string[] {
  return listLeanServers()
    .filter(isLeanServerActive)
    .map((info) => info.workspaceRoot)
    .toSorted((a, b) => a.localeCompare(b));
}

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
  closeDelayMs?: number;
  silent?: boolean;
  /** Answer `initialize` only once this settles. */
  initializeGate?: Promise<void>;
}): FakeLeanChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = Buffer.alloc(0);
  const closeDelayMs = options?.closeDelayMs ?? 0;

  function send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdout.write(body);
  }

  function handle(message: {
    id?: number;
    method?: string;
    params?: { textDocument?: { uri?: string } };
  }): void {
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
    pid: 4242,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    emit: events.emit.bind(events),
    kill(signal?: NodeJS.Signals) {
      if (this.exitCode != null || this.signalCode != null) return true;
      this.killed = true;
      this.exitCode = 0;
      this.emit('exit', 0, signal ?? null);
      const finish = () => {
        if (!stdin.destroyed) stdin.end();
        if (!stdout.destroyed) stdout.end();
        if (!stderr.destroyed) stderr.end();
        this.emit('close', 0, null);
      };
      if (closeDelayMs > 0) setTimeout(finish, closeDelayMs);
      else finish();
      return true;
    },
    closeSoon() {
      this.exitCode = 1;
      this.emit('close', 1, null);
    },
    unref() {},
    ref() {},
  });
  return child;
}
