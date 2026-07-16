// Suites for src/tools/lean helper modules (hover text, workspace-root
// resolution, external-tool status, lake command mutex). The LSP adapter,
// server registry, and JSON-RPC connection keep their own suites.

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * Vitests for `defaultResolveWorkspaceRoot` — walks up from a file looking
 * for `lakefile.lean` or `lakefile.toml`.
 */

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
const PARALLEL_BUDGET_MS = 600;
const SLEEP_PER_CALL_MS = 120;

function nodeSleep(ms: number, marker: string): readonly string[] {
  // Emits `marker:start`, sleeps, then `marker:end` on stdout so we can
  // reconstruct the interleaving from captured output.
  return [
    '-e',
    `process.stdout.write('${marker}:start\\n'); ` +
      `setTimeout(() => { process.stdout.write('${marker}:end\\n'); }, ${ms});`,
  ];
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

  it('serializes calls against the same workspace when `serialize: true`', async () => {
    const startedAt = performance.now();
    const [first, second] = await Promise.all([
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(60, 'a'),
        serialize: true,
      }).then((result) => ({ result, finishedAt: performance.now() })),
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(10, 'b'),
        serialize: true,
      }).then((result) => ({ result, finishedAt: performance.now() })),
    ]);
    expect(first.result.exitCode).toBe(0);
    expect(second.result.exitCode).toBe(0);
    expect(first.result.stdout).toContain('a:start');
    expect(first.result.stdout).toContain('a:end');
    expect(second.result.stdout).toContain('b:start');
    expect(second.result.stdout).toContain('b:end');
    expect(second.finishedAt).toBeGreaterThanOrEqual(first.finishedAt);
    expect(second.finishedAt - startedAt).toBeGreaterThanOrEqual(
      first.finishedAt - startedAt,
    );
  });

  it('runs calls in parallel across different workspaces', async () => {
    const start = Date.now();
    await Promise.all([
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(SLEEP_PER_CALL_MS, 'a'),
        serialize: true,
      }),
      runLakeCommand({
        workspaceRoot: workspaceB,
        lakeCommand: NODE,
        args: nodeSleep(SLEEP_PER_CALL_MS, 'b'),
        serialize: true,
      }),
    ]);
    // Serialized, the two sleeps would take >= 2*SLEEP_PER_CALL_MS. In
    // parallel they finish in roughly SLEEP_PER_CALL_MS plus startup. The
    // budget allows comfortable headroom while still distinguishing the two.
    expect(Date.now() - start).toBeLessThan(PARALLEL_BUDGET_MS);
  });

  it('does not serialize when `serialize: false`', async () => {
    const start = Date.now();
    await Promise.all([
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(SLEEP_PER_CALL_MS, 'a'),
        serialize: false,
      }),
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(SLEEP_PER_CALL_MS, 'b'),
        serialize: false,
      }),
    ]);
    expect(Date.now() - start).toBeLessThan(PARALLEL_BUDGET_MS);
  });
});
