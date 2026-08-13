// Suites for src/tools/lean helper modules (hover text, workspace-root
// resolution, external-tool status, lake command mutex). The LSP adapter,
// server registry, and JSON-RPC connection keep their own suites.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findExternalToolDef } from '@tools/externalToolDefs';
import { defaultResolveWorkspaceRoot } from '@tools/lean/direct/directLspAdapter';
import {
  clearLeanServerRegistry,
  registerLeanServer,
  updateLeanServer,
} from '@tools/lean/leanServerRegistry';
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
// DefaultResolveWorkspaceRoot
// ---------------------------------------------------------------------------

describe('defaultResolveWorkspaceRoot', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'texra-lean-root-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('finds lakefile.lean in the same directory', async () => {
    await writeFile(path.join(scratch, 'lakefile.lean'), '');
    await writeFile(path.join(scratch, 'Foo.lean'), '');
    const root = await defaultResolveWorkspaceRoot(
      path.join(scratch, 'Foo.lean'),
    );
    expect(root).toBe(scratch);
  });

  it('finds lakefile.toml two directories up', async () => {
    await writeFile(path.join(scratch, 'lakefile.toml'), '');
    const sub = path.join(scratch, 'a', 'b');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'Foo.lean'), '');
    const root = await defaultResolveWorkspaceRoot(path.join(sub, 'Foo.lean'));
    expect(root).toBe(scratch);
  });

  it('returns null when no lakefile is found in any ancestor', async () => {
    const sub = path.join(scratch, 'no-lake');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'Foo.lean'), '');
    const root = await defaultResolveWorkspaceRoot(path.join(sub, 'Foo.lean'));
    expect(root).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LeanExternalToolStatus
// ---------------------------------------------------------------------------

describe('Lean external tool status', () => {
  afterEach(() => {
    clearLeanServerRegistry();
  });

  it('counts only starting and running Lean servers as active', async () => {
    const lean = findExternalToolDef('lean4');
    expect(lean?.statusLabel).toBeDefined();

    registerLeanServer({
      id: 'direct:/failed',
      workspaceRoot: '/failed',
      mode: 'direct-lsp',
      status: 'error',
    });
    registerLeanServer({
      id: 'direct:/stopped',
      workspaceRoot: '/stopped',
      mode: 'direct-lsp',
      status: 'stopped',
    });

    await expect(
      lean!.statusLabel!({ extensionAvailable: false, lakeAvailable: true }),
    ).resolves.toBeUndefined();

    registerLeanServer({
      id: 'direct:/running',
      workspaceRoot: '/running',
      mode: 'direct-lsp',
      status: 'starting',
    });
    await expect(
      lean!.statusLabel!({ extensionAvailable: false, lakeAvailable: true }),
    ).resolves.toBe('1 server active');

    updateLeanServer('direct:/running', { status: 'running' });
    await expect(
      lean!.statusLabel!({ extensionAvailable: false, lakeAvailable: true }),
    ).resolves.toBe('1 server active');
  });
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

  it('keeps the current 4,194,304-character tail cap and truncation marker', async () => {
    const result = await runLakeCommand({
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
  });

  it('preserves non-zero exit diagnostics', async () => {
    const result = await runLakeCommand({
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
  });

  it('preserves timeout diagnostics', async () => {
    const result = await runLakeCommand({
      workspaceRoot: workspaceA,
      lakeCommand: NODE,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 20,
    });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('timed out after 20 milliseconds');
  });

  it('serializes calls against the same workspace when `serialize: true`', async () => {
    const gateA = path.join(workspaceA, 'gate-a');
    const readyA = path.join(workspaceA, 'ready-a');
    const gateB = path.join(workspaceA, 'gate-b');
    const readyB = path.join(workspaceA, 'ready-b');

    const first = runLakeCommand({
      workspaceRoot: workspaceA,
      lakeCommand: NODE,
      args: nodeGateCommand(readyA, gateA),
      serialize: true,
    });
    const second = runLakeCommand({
      workspaceRoot: workspaceA,
      lakeCommand: NODE,
      args: nodeGateCommand(readyB, gateB),
      serialize: true,
    });

    // The first child holds the workspace mutex: it starts and blocks on its
    // gate. While that gate holds, the second call's child cannot have
    // spawned — if the mutex were broken, the second child would announce
    // itself during the first waitFor poll window.
    await waitForFile(readyA);
    expect(existsSync(readyB)).toBe(false);

    // Only releasing the first call lets the second child start.
    writeFileSync(gateA, 'go');
    await waitForFile(readyB);
    writeFileSync(gateB, 'go');

    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each<{
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
  ])('runs calls in parallel $name', async ({ secondWorkspace, serialize }) => {
    const gateA = path.join(workspaceA, 'gate-a');
    const readyA = path.join(workspaceA, 'ready-a');
    const gateB = path.join(secondWorkspace(), 'gate-b');
    const readyB = path.join(secondWorkspace(), 'ready-b');

    const calls = Promise.all([
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
    ]);

    // Both children announce themselves while each is still blocked on its
    // own gate — only possible when the calls run concurrently. If they were
    // serialized, the second child would never spawn (its gate could never
    // be released first) and this poll would time out and fail the test.
    await waitForFile(readyA);
    await waitForFile(readyB);

    writeFileSync(gateA, 'go');
    writeFileSync(gateB, 'go');
    const results = await calls;
    for (const result of results) {
      expect(result.exitCode).toBe(0);
    }
  });
});
