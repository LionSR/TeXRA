/**
 * Vitests for `runLakeCommand` — the per-workspace mutex semantics. We don't
 * need a real `lake` binary; `node -e` is available on every test runner and
 * lets us simulate work + observe ordering.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runLakeCommand } from '@tools/lean/direct/lakeCommands';

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

describe('runLakeCommand mutex', () => {
  it('serializes calls against the same workspace when `serialize: true`', async () => {
    const [first, second] = await Promise.all([
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(60, 'a'),
        serialize: true,
      }),
      runLakeCommand({
        workspaceRoot: workspaceA,
        lakeCommand: NODE,
        args: nodeSleep(10, 'b'),
        serialize: true,
      }),
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toContain('a:start');
    expect(first.stdout).toContain('a:end');
    expect(second.stdout).toContain('b:start');
    expect(second.stdout).toContain('b:end');
    expect(second.stdout.indexOf('b:end')).toBeGreaterThan(
      second.stdout.indexOf('b:start'),
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
