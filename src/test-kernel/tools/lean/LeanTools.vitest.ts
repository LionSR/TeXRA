// Suites for src/tools/lean helper modules (hover text, workspace-root
// resolution, external-tool status, lake command mutex). The LSP adapter,
// server registry, and JSON-RPC connection keep their own suites.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { withProcessServices } from '@platform/processRuntime';
import { testRuntime } from '@test/support/testProcessRuntime';
import { findExternalToolDef } from '@tools/externalToolDefs';
import { resolveWorkspaceRoot } from '@tools/lean/direct/leanServerPool';
import { createLeanServerRoster } from '@tools/lean/leanServerRegistry';
import { extractHoverText } from '@tools/lean/leanTypes';
import { runLakeCommand } from '@tools/lean/direct/lakeCommands';

// ---------------------------------------------------------------------------
// LeanHoverTypes
// ---------------------------------------------------------------------------

describe('extractHoverText', () => {
  it.each<{
    name: string;
    contents: Parameters<typeof extractHoverText>[0];
    expected: string;
  }>([
    {
      name: 'extracts plain string hover contents',
      contents: 'Nat.succ',
      expected: 'Nat.succ',
    },
    {
      name: 'joins marked string hover contents',
      contents: [{ language: 'lean4', value: '#check Nat' }, 'natural numbers'],
      expected: '#check Nat\n\nnatural numbers',
    },
    {
      name: 'extracts single marked string hover contents',
      contents: { language: 'lean4', value: '#check Nat' },
      expected: '#check Nat',
    },
    {
      name: 'extracts markup content hover values',
      contents: { kind: 'markdown', value: '**theorem** foo' },
      expected: '**theorem** foo',
    },
  ])('$name', ({ contents, expected }) => {
    expect(extractHoverText(contents)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// ResolveWorkspaceRoot
// ---------------------------------------------------------------------------

describe('resolveWorkspaceRoot', () => {
  let scratch: string;

  const resolve = (filePath: string): Effect.Effect<string | null> =>
    resolveWorkspaceRoot(filePath);

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'texra-lean-root-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.effect('finds lakefile.lean in the same directory', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(path.join(scratch, 'lakefile.lean'), ''),
      );
      yield* Effect.promise(() =>
        writeFile(path.join(scratch, 'Foo.lean'), ''),
      );
      const root = yield* resolve(path.join(scratch, 'Foo.lean'));
      expect(root).toBe(scratch);
    }),
  );

  it.effect('finds lakefile.toml two directories up', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(path.join(scratch, 'lakefile.toml'), ''),
      );
      const sub = path.join(scratch, 'a', 'b');
      yield* Effect.promise(() => mkdir(sub, { recursive: true }));
      yield* Effect.promise(() => writeFile(path.join(sub, 'Foo.lean'), ''));
      const root = yield* resolve(path.join(sub, 'Foo.lean'));
      expect(root).toBe(scratch);
    }),
  );

  it.effect('returns null when no lakefile is found in any ancestor', () =>
    Effect.gen(function* () {
      const sub = path.join(scratch, 'no-lake');
      yield* Effect.promise(() => mkdir(sub, { recursive: true }));
      yield* Effect.promise(() => writeFile(path.join(sub, 'Foo.lean'), ''));
      const root = yield* resolve(path.join(sub, 'Foo.lean'));
      expect(root).toBeNull();
    }),
  );
});

// ---------------------------------------------------------------------------
// LeanExternalToolStatus
// ---------------------------------------------------------------------------

describe('Lean external tool status', () => {
  it.effect('counts only starting and running Lean servers as active', () =>
    Effect.gen(function* () {
      const lean = findExternalToolDef('lean4');
      expect(lean?.statusLabel).toBeDefined();

      // The roster the host's adapter hands the probe, as the probe passes it on
      // to the status callbacks.
      const roster = createLeanServerRoster();
      const prerequisites = () => ({
        extensionAvailable: false,
        lakeAvailable: true,
        requiresExtension: false,
        servers: roster.list(),
      });

      roster.register({
        id: 'direct:/failed',
        workspaceRoot: '/failed',
        mode: 'direct-lsp',
        status: 'error',
      });
      roster.register({
        id: 'direct:/stopped',
        workspaceRoot: '/stopped',
        mode: 'direct-lsp',
        status: 'stopped',
      });

      expect(
        yield* withProcessServices(
          testRuntime(),
          lean!.statusLabel!(prerequisites()),
        ),
      ).toBeUndefined();

      roster.register({
        id: 'direct:/running',
        workspaceRoot: '/running',
        mode: 'direct-lsp',
        status: 'starting',
      });
      expect(
        yield* withProcessServices(
          testRuntime(),
          lean!.statusLabel!(prerequisites()),
        ),
      ).toBe('1 server active');

      roster.update('direct:/running', { status: 'running' });
      expect(
        yield* withProcessServices(
          testRuntime(),
          lean!.statusLabel!(prerequisites()),
        ),
      ).toBe('1 server active');
    }),
  );
});

// ---------------------------------------------------------------------------
// LakeCommandsMutex
// ---------------------------------------------------------------------------

/**
 * Vitests for `runLakeCommand` — the per-workspace mutex semantics. We don't
 * need a real `lake` binary; `node -e` is available on every test runner and
 * lets us simulate work + observe ordering.
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
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(() => {
    workspaceA = mkdtempSync(path.join(tmpdir(), 'texra-lake-mutex-a-'));
    workspaceB = mkdtempSync(path.join(tmpdir(), 'texra-lake-mutex-b-'));
  });

  afterEach(() => {
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  });

  it.live(
    'keeps the current 4,194,304-character tail cap and truncation marker',
    () =>
      Effect.gen(function* () {
        const result = yield* runLakeCommand({
          workspaceRoot: workspaceA,
          lakeCommand: NODE,
          args: [
            '-e',
            `process.stdout.write('HEAD_MARKER' + 'x'.repeat(${4 * 1024 * 1024 + 100}) + 'TAIL_MARKER')`,
          ],
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.startsWith('…[output truncated]…\n')).toBe(true);
        expect(result.stdout).not.toContain('HEAD_MARKER');
        expect(result.stdout.endsWith('TAIL_MARKER')).toBe(true);
        expect(result.stdout.length).toBe(
          4 * 1024 * 1024 + '…[output truncated]…\n'.length,
        );
      }),
  );

  it.live('preserves non-zero exit diagnostics', () =>
    Effect.gen(function* () {
      const result = yield* runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: [
          '-e',
          `process.stdout.write('build context'); process.stderr.write('compile failed'); process.exit(7)`,
        ],
      });

      expect(result).toEqual({
        exitCode: 7,
        stdout: 'build context',
        stderr: 'compile failed',
      });
    }),
  );

  it.live('preserves timeout diagnostics', () =>
    Effect.gen(function* () {
      const result = yield* runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: ['-e', 'setTimeout(() => {}, 60_000)'],
        timeoutMs: 20,
      });

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain('timed out after 20 milliseconds');
    }),
  );

  it.live(
    'serializes calls against the same workspace when `serialize: true`',
    () =>
      Effect.gen(function* () {
        const gateA = path.join(workspaceA, 'gate-a');
        const readyA = path.join(workspaceA, 'ready-a');
        const gateB = path.join(workspaceA, 'gate-b');
        const readyB = path.join(workspaceA, 'ready-b');

        const first = yield* Effect.forkChild(
          runLakeCommand({
            workspaceRoot: workspaceA,
            lakeCommand: NODE,
            args: nodeGateCommand(readyA, gateA),
            serialize: true,
          }),
          { startImmediately: true },
        );
        const second = yield* Effect.forkChild(
          runLakeCommand({
            workspaceRoot: workspaceA,
            lakeCommand: NODE,
            args: nodeGateCommand(readyB, gateB),
            serialize: true,
          }),
          { startImmediately: true },
        );

        // The first child holds the workspace mutex: it starts and blocks on its
        // gate. While that gate holds, the second call's child cannot have
        // spawned — if the mutex were broken, the second child would announce
        // itself during the first waitFor poll window.
        yield* Effect.promise(() => waitForFile(readyA));
        expect(existsSync(readyB)).toBe(false);

        // Only releasing the first call lets the second child start.
        writeFileSync(gateA, 'go');
        yield* Effect.promise(() => waitForFile(readyB));
        writeFileSync(gateB, 'go');

        expect(yield* Fiber.join(first)).toMatchObject({ exitCode: 0 });
        expect(yield* Fiber.join(second)).toMatchObject({ exitCode: 0 });
      }),
  );

  it.live.each<{
    name: string;
    secondWorkspace: () => string;
    serialize: boolean;
  }>([
    {
      name: 'across different workspaces',
      secondWorkspace: () => workspaceB,
      serialize: true,
    },
    {
      name: 'when `serialize: false`',
      secondWorkspace: () => workspaceA,
      serialize: false,
    },
  ])('runs calls in parallel $name', ({ secondWorkspace, serialize }) =>
    Effect.gen(function* () {
      const gateA = path.join(workspaceA, 'gate-a');
      const readyA = path.join(workspaceA, 'ready-a');
      const gateB = path.join(secondWorkspace(), 'gate-b');
      const readyB = path.join(secondWorkspace(), 'ready-b');

      const calls = yield* Effect.forkChild(
        Effect.all(
          [
            runLakeCommand({
              workspaceRoot: workspaceA,
              lakeCommand: NODE,
              args: nodeGateCommand(readyA, gateA),
              serialize,
            }),
            runLakeCommand({
              workspaceRoot: secondWorkspace(),
              lakeCommand: NODE,
              args: nodeGateCommand(readyB, gateB),
              serialize,
            }),
          ],
          { concurrency: 'unbounded' },
        ),
        { startImmediately: true },
      );

      // Both children announce themselves while each is still blocked on its
      // own gate — only possible when the calls run concurrently. If they were
      // serialized, the second child would never spawn (its gate could never
      // be released first) and this poll would time out and fail the test.
      yield* Effect.promise(() => waitForFile(readyA));
      yield* Effect.promise(() => waitForFile(readyB));

      writeFileSync(gateA, 'go');
      writeFileSync(gateB, 'go');
      const results = yield* Fiber.join(calls);
      for (const result of results) {
        expect(result.exitCode).toBe(0);
      }
    }),
  );
});
