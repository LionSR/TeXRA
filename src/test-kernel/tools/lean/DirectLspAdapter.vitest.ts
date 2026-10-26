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
  LeanServerPool,
  type LeanServerPoolOptions,
} from '@texra/tools/lean/direct/leanServerPool';
import {
  isLeanServerActive,
  type LeanServerInfo,
} from '@texra/tools/lean/leanServerRegistry';

const FAKE_LAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const countPath = process.env.TEXRA_FAKE_LEAN_COUNT;

if (!process.argv.includes('--server')) {
  if (countPath) fs.appendFileSync(countPath, 'command\\n');
  // A held command runs until its release file appears.
  const release = process.env.TEXRA_FAKE_LEAN_LAKE_RELEASE;
  const finish = () =>
    !release || fs.existsSync(release) ? process.exit(0) : setTimeout(finish, 10);
  finish();
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

  fakeLakeIt.effect(
    'stops a shared server after its final owner and lease end',
    () =>
      Effect.gen(function* () {
        const { pool } = yield* openPool();
        yield* settle(pool.fetchDiagnosticsForFile(filePath, run('e00001')));
        expect(activeServerRoots(pool)).toEqual([projectRoot]);
        const release = path.join(tempRoot, 'build.release');
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_RELEASE', release);
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

        writeFileSync(release, '');
        yield* Fiber.join(build);
        expect(activeServerRoots(pool)).toEqual([]);
      }),
  );
});

function run(runId: string): RunId {
  return runId as RunId;
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
