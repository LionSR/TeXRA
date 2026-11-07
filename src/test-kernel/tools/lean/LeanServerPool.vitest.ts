/**
 * The direct Lean pool's server lifetimes, under `it.effect`'s `TestClock`
 * where the diagnostics waits are the subject. Servers are a fake `lake`
 * script on `PATH`, run as a real child process. It reads its switches from
 * files beside its own directory, so nothing reaches it through the worker's
 * environment but `PATH`.
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
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Scope,
} from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { directLeanLanguageServices } from '@texra/tools/lean/direct/leanServerPool';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import { isLeanServerActive } from '@texra/tools/lean/leanServerInfo';

const FAKE_LAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(path.dirname(__filename));
const countPath = path.join(root, 'events.txt');

if (!process.argv.includes('--server')) {
  fs.appendFileSync(countPath, 'command\\n');
  // A command runs until no hold file is there.
  const hold = path.join(root, 'hold-commands');
  const finish = () =>
    fs.existsSync(hold) ? setTimeout(finish, 10) : process.exit(0);
  finish();
  return;
}

fs.appendFileSync(countPath, 'start\\n');

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
    if (fs.existsSync(path.join(root, 'suppress-diagnostics'))) return;
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
    fs.appendFileSync(countPath, 'diagnostics\\n');
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
let countPath: string;
let filePath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'texra-direct-lsp-'));
  projectRoot = path.join(tempRoot, 'project');
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'lakefile.toml'), 'name = "Test"\n');
  filePath = path.join(projectRoot, 'Test.lean');
  writeFileSync(filePath, 'example : True := by trivial\n');
  const bin = path.join(tempRoot, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'lake'), FAKE_LAKE);
  chmodSync(path.join(bin, 'lake'), 0o755);
  countPath = path.join(tempRoot, 'events.txt');
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
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
    directLeanLanguageServices.pipe(Layer.provide(spawnerLayer)),
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
 * Repeat `check` every 10 ms of real time until it returns true, for at most
 * 5 s. The waits are on a child process, which the test clock does not move.
 */
const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  check.pipe(
    Effect.repeat({
      schedule: Schedule.spaced('10 millis'),
      until: (done) => done,
    }),
    Effect.timeout('5 seconds'),
    TestClock.withLive,
  );

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
    // Captured here: `until` runs its check on the live clock.
    const testClock = yield* TestClock.testClockWith(Effect.succeed);
    yield* until(
      Effect.gen(function* () {
        if ((yield* logged('diagnostics')) > before)
          yield* testClock.adjust('100 millis');
        return yield* Deferred.isDone(done);
      }),
    );
    return yield* Fiber.join(fiber);
  });

const fakeLakeIt = it.effect.skipIf(process.platform === 'win32');

describe('direct Lean pool', () => {
  fakeLakeIt(
    'does not stop a server while a diagnostics request is in flight',
    () =>
      Effect.gen(function* () {
        writeFileSync(path.join(tempRoot, 'suppress-diagnostics'), '');
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
      const hold = path.join(tempRoot, 'hold-commands');
      writeFileSync(hold, '');
      const build = yield* Effect.forkChild(
        pool.executeProjectCommand('build').pipe(Scope.provide(first.run)),
      );
      // Running, so its lease is held.
      yield* until(Effect.map(logged('command'), (count) => count === 1));
      yield* settle(
        pool.fetchDiagnosticsForFile(filePath).pipe(Scope.provide(second.run)),
      );

      // Ending one run keeps the shared server for the other; ending the
      // last leaves it to the build already running, until its lease ends.
      yield* second.end;
      expect(yield* activeServerRoots(pool)).toEqual([projectRoot]);
      yield* first.end;
      expect(yield* activeServerRoots(pool)).toEqual([projectRoot]);

      rmSync(hold);
      yield* Fiber.join(build);
      expect(yield* activeServerRoots(pool)).toEqual([]);
    }),
  );
});

type Pool = LeanLanguageServices['Service'];

/** Wait until the roots with servers in `status` are `roots`. */
const untilRoots = (pool: Pool, status: string, roots: string[]) =>
  until(
    Effect.map(
      pool.listServers,
      (list) =>
        list
          .filter((info) => info.status === status)
          .map((info) => info.workspaceRoot)
          .join() === roots.join(),
    ),
  );

const activeServerRoots = (pool: Pool) =>
  Effect.map(pool.listServers, (list) =>
    list
      .filter(isLeanServerActive)
      .map((info) => info.workspaceRoot)
      .toSorted((a, b) => a.localeCompare(b)),
  );
