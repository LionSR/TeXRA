/**
 * The direct Lean pool's server lifetimes, under `it.effect`'s `TestClock`
 * where the diagnostics waits are the subject. Servers are a fake `lake`
 * script run as a real child process.
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
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { directLeanLanguageServices } from '@texra/tools/lean/direct/leanServerPool';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import { isLeanServerActive } from '@texra/tools/lean/leanServerInfo';

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
  if (message.method === 'exit') process.exit(0);
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

/** The spawner graph the process runtime serves the pool. */
const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

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
const openPool = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const pool = yield* Layer.build(
    directLeanLanguageServices(fakeLakePath).pipe(Layer.provide(spawnerLayer)),
  ).pipe(
    Scope.provide(scope),
    Effect.map((context) => Context.get(context, LeanLanguageServices)),
  );
  return { pool, dispose: Scope.close(scope, Exit.void) };
});

/** A run's scope, closed by the test scope unless ended first. */
const openRun = Effect.gen(function* () {
  const run = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(run, Exit.void));
  return { run, end: Scope.close(run, Exit.void) };
});

/**
 * Run `effect` to its end, stepping the test clock only once the fake server
 * has sent this request's diagnostics. Until then the wait is real I/O (a
 * child process starting, which takes seconds under load) and the clock
 * stands still, so the handshake and diagnostics timeouts on it cannot fire;
 * after it, only the diagnostics quiet window is left to pass. A request on
 * an already-open file sends nothing and ends on its own.
 */
const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
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

const fakeLakeIt = it.effect.skipIf(process.platform === 'win32');

describe('direct Lean pool', () => {
  fakeLakeIt(
    'does not stop a server while a diagnostics request is in flight',
    () =>
      Effect.gen(function* () {
        vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
        const { pool, dispose } = yield* openPool;
        const pending = yield* Effect.forkChild(
          Effect.scoped(pool.fetchDiagnosticsForFile(filePath)),
        );
        yield* untilRoots(pool, 'running', [projectRoot]);

        // Still inside the diagnostics wait: the call's lease keeps it.
        yield* TestClock.adjust('5 seconds');
        expect(yield* activeServerRoots(pool)).toEqual([projectRoot]);

        yield* dispose;
        // A server stopped under the call is a stop, not a missing toolchain.
        const failure = yield* Effect.flip(Fiber.join(pending));
        expect(failure._tag).toBe('LeanUnavailable');
        expect(failure.message).toMatch(/^The Lean server stopped/);
        expect(yield* activeServerRoots(pool)).toEqual([]);
      }),
  );

  fakeLakeIt('stops a shared server after its last run and lease end', () =>
    Effect.gen(function* () {
      const { pool } = yield* openPool;
      const first = yield* openRun;
      const second = yield* openRun;
      yield* settle(
        pool.fetchDiagnosticsForFile(filePath).pipe(Scope.provide(first.run)),
      );
      expect(yield* activeServerRoots(pool)).toEqual([projectRoot]);
      const release = path.join(tempRoot, 'build.release');
      vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_RELEASE', release);
      const build = yield* Effect.forkChild(
        pool.executeProjectCommand('build').pipe(Scope.provide(first.run)),
      );
      // Running, so its lease is held.
      yield* eventually(async () =>
        expect(await countLogged('command')).toBe(1),
      );
      yield* settle(
        pool.fetchDiagnosticsForFile(filePath).pipe(Scope.provide(second.run)),
      );

      // Ending one run keeps the shared server for the other; ending the
      // last leaves it to the build already running, until its lease ends.
      yield* second.end;
      expect(yield* activeServerRoots(pool)).toEqual([projectRoot]);
      yield* first.end;
      expect(yield* activeServerRoots(pool)).toEqual([projectRoot]);

      writeFileSync(release, '');
      yield* Fiber.join(build);
      expect(yield* activeServerRoots(pool)).toEqual([]);
    }),
  );
});

type Pool = LeanLanguageServices['Service'];

/** Wait, on real time, until the roots with servers in `status` are `roots`. */
const untilRoots = (pool: Pool, status: string, roots: string[]) =>
  Effect.gen(function* () {
    const read = Effect.map(pool.listServers, (list) =>
      list
        .filter((info) => info.status === status)
        .map((info) => info.workspaceRoot),
    );
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const current = yield* read;
      if (current.join() === roots.join()) return;
      yield* Effect.promise(() => delay(10));
    }
    expect(yield* read).toEqual(roots);
  });

const activeServerRoots = (pool: Pool) =>
  Effect.map(pool.listServers, (list) =>
    list
      .filter(isLeanServerActive)
      .map((info) => info.workspaceRoot)
      .toSorted((a, b) => a.localeCompare(b)),
  );
