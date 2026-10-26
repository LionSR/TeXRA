// Suites for packages/harness/src/utils/system/execUtils.

// Node imports
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { build } from 'esbuild';
import { Effect, Exit, Fiber } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { executeCommand } from '@texra-ai/harness/node';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';

// ---------------------------------------------------------------------------
// execUtils
// ---------------------------------------------------------------------------

// Signal delivery to a whole process group, and the kernel reaping the members,
// is not instant — and gets markedly slower when the suite is saturating every
// core. The budget is generous (~10s) because it exists to catch a genuinely
// leaked child, not to measure teardown latency; a tight one only produces
// flakes on loaded machines.
//
// It exceeds the suite-wide `testTimeout: 10000` in vitest.config.mjs, so every
// test calling this must pass PROCESS_EXIT_TEST_TIMEOUT_MS. Without it the
// runner aborts the test mid-poll and the extra budget buys nothing.
const PROCESS_EXIT_TEST_TIMEOUT_MS = 30_000;

function waitForProcessExit(pid: number): Promise<void> {
  return waitForCondition(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    {
      timeoutMs: 10_000,
      intervalMs: 20,
      timeoutMessage: `Timed out waiting for process ${pid} to exit`,
    },
  );
}

// Backgrounds a long sleep, records its pid, then blocks on `wait` so the
// tracked shell keeps running while the descendant holds the inherited stdio.
const SLEEPER_SCRIPT = 'sleep 60 & echo $! > "$PID_FILE"; wait';
// The shell's `>` creates the pid file before `echo` writes to it, so under
// load the file can exist and still be empty; wait for a parseable pid.
async function waitForPublishedPid(pidFile: string): Promise<number> {
  let pid = Number.NaN;
  await waitForCondition(
    () => {
      pid = existsSync(pidFile)
        ? Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
        : Number.NaN;
      return Number.isInteger(pid) && pid > 0;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 20,
      timeoutMessage: `Timed out waiting for a pid in ${pidFile}`,
    },
  );
  return pid;
}

describe('executeCommand', () => {
  const tempDirs = useTempDirs();

  // The cases below hand `executeCommand` the same directory the fake
  // platform's workspace names, so the spawn has a real cwd on disk.
  const WORKSPACE = process.cwd();
  setupPlatform({ workspacePath: WORKSPACE });

  it.live(
    "withholds TeXRA's provider key variables from the child and keeps the rest",
    () =>
      Effect.gen(function* () {
        const saved = {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          TEXRA_TEST_UNRELATED: process.env.TEXRA_TEST_UNRELATED,
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const [name, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }),
        );
        process.env.OPENAI_API_KEY = 'sk-owned-by-texra';
        process.env.TEXRA_TEST_UNRELATED = 'kept';

        const result = yield* executeCommand(
          [
            process.execPath,
            '-e',
            `process.stdout.write(JSON.stringify([process.env.OPENAI_API_KEY ?? null, process.env.TEXRA_TEST_UNRELATED ?? null]))`,
          ],
          { cwd: WORKSPACE, settings: undefined },
        );

        expect(JSON.parse(result.stdout)).toStrictEqual([null, 'kept']);
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );

  it.live(
    'tears down shell process groups when the running fiber is interrupted',
    () =>
      Effect.gen(function* () {
        if (process.platform === 'win32') return;

        const dir = yield* Effect.promise(() =>
          makeTempDir('texra-exec-interrupt-', tempDirs),
        );
        const pidFile = join(dir, 'sleep.pid');
        const fiber = yield* Effect.forkChild(
          executeCommand(SLEEPER_SCRIPT, {
            cwd: dir,
            settings: undefined,
            timeout: 60_000,
            env: { PID_FILE: pidFile },
          }),
        );
        const childPid = yield* Effect.promise(() =>
          waitForPublishedPid(pidFile),
        );
        yield* Fiber.interrupt(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);

        // The interrupt is the only teardown here: no abort signal is threaded
        // through, so the backgrounded sleep dies because `executeCommand`'s own
        // finalizer signalled the detached shell's process group.
        yield* Effect.promise(() => waitForProcessExit(childPid));
      }).pipe(Effect.provide(nodeSpawnerLayer)),
    PROCESS_EXIT_TEST_TIMEOUT_MS,
  );

  it.live(
    'ends a shell command with its host when the host is SIGKILLed',
    () =>
      Effect.gen(function* () {
        if (process.platform === 'win32') return;

        // A host process that starts one timed shell through the production
        // spawner and holds it; a SIGKILL runs none of its finalizers.
        const dir = yield* Effect.promise(() =>
          makeTempDir('texra-exec-lifeline-', tempDirs),
        );
        const pidFile = join(dir, 'shell.pid');
        const entry = join(dir, 'host.ts');
        writeFileSync(
          entry,
          [
            "import { Effect } from 'effect';",
            "import { nodePlatformServices } from '@platform/defaults/nodePlatform';",
            "import { executeCommand } from '@utils/system/execUtils';",
            'Effect.runFork(',
            '  executeCommand(\'echo $$ > "$PID_FILE"; sleep 30 && touch marker\', {',
            '    cwd: process.cwd(),',
            '    settings: undefined,',
            '    timeout: 60_000,',
            '    env: { PID_FILE: process.env.PID_FILE! },',
            '  }).pipe(Effect.provide(nodePlatformServices)),',
            ');',
          ].join('\n'),
        );
        yield* Effect.promise(() =>
          build({
            entryPoints: [entry],
            outfile: join(dir, 'host.cjs'),
            bundle: true,
            // CommonJS: bundled dependencies `require` Node built-ins.
            format: 'cjs',
            platform: 'node',
            logLevel: 'silent',
            tsconfig: join(WORKSPACE, 'tsconfig.json'),
            nodePaths: [join(WORKSPACE, 'node_modules')],
          }),
        );
        const host = spawn(process.execPath, [join(dir, 'host.cjs')], {
          cwd: dir,
          env: { ...process.env, PID_FILE: pidFile },
          stdio: 'ignore',
        });
        // The shell leads its own process group, so its pid is the group id.
        const group = yield* Effect.promise(() => waitForPublishedPid(pidFile));

        host.kill('SIGKILL');
        yield* Effect.promise(() => waitForProcessExit(-group));
        assert.equal(existsSync(join(dir, 'marker')), false);
      }),
    // The bundle build comes on top of the process-exit budget.
    2 * PROCESS_EXIT_TEST_TIMEOUT_MS,
  );
});
