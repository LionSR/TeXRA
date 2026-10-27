import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { runLakeCommand } from '@texra/tools/lean/direct/lakeCommands';

/**
 * `runLakeCommand`'s per-workspace mutex. We don't need a real `lake` binary;
 * `node -e` is available on every test runner and lets us simulate work and
 * observe ordering.
 */

const NODE = process.execPath;

/**
 * A child process that announces its startup by writing `readyPath` and then
 * blocks until `gatePath` exists, so tests can observe process startup and
 * control process completion deterministically — no wall-clock budgets. The
 * child self-terminates (exit 1) if the gate never lands, so a failing test
 * cannot leak a hung process.
 */
function nodeGateCommand(
  readyPath: string,
  gatePath: string,
): readonly string[] {
  return [
    '-e',
    `const fs = require('node:fs');` +
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');` +
      `const poll = setInterval(() => {` +
      ` if (fs.existsSync(${JSON.stringify(gatePath)})) {` +
      ` clearInterval(poll); process.exit(0);` +
      ` }` +
      `}, 5);` +
      `setTimeout(() => process.exit(1), 30_000).unref();`,
  ];
}

async function waitForFile(filePath: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(existsSync(filePath)).toBe(true);
    },
    { timeout: 10_000, interval: 10 },
  );
}

describe('runLakeCommand mutex', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'texra-lake-mutex-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  // Two lake builds in one workspace at once race on its `.lake` directory.
  it.live('serializes calls against the same workspace', () =>
    Effect.gen(function* () {
      const gateA = path.join(workspace, 'gate-a');
      const readyA = path.join(workspace, 'ready-a');
      const gateB = path.join(workspace, 'gate-b');
      const readyB = path.join(workspace, 'ready-b');

      const first = yield* Effect.forkChild(
        runLakeCommand({
          workspaceRoot: workspace,
          lakeCommand: NODE,
          args: nodeGateCommand(readyA, gateA),
        }),
        { startImmediately: true },
      );
      const second = yield* Effect.forkChild(
        runLakeCommand({
          workspaceRoot: workspace,
          lakeCommand: NODE,
          args: nodeGateCommand(readyB, gateB),
        }),
        { startImmediately: true },
      );

      // The first child holds the workspace mutex: it starts and blocks on
      // its gate. While that gate holds, the second call's child cannot
      // have spawned — if the mutex were broken, the second child would
      // announce itself during the first waitFor poll window.
      yield* Effect.promise(() => waitForFile(readyA));
      expect(existsSync(readyB)).toBe(false);

      // Only releasing the first call lets the second child start.
      writeFileSync(gateA, 'go');
      yield* Effect.promise(() => waitForFile(readyB));
      writeFileSync(gateB, 'go');

      expect(yield* Fiber.join(first)).toMatchObject({ exitCode: 0 });
      expect(yield* Fiber.join(second)).toMatchObject({ exitCode: 0 });
    }).pipe(Effect.provide(nodeSpawnerLayer)),
  );
});
