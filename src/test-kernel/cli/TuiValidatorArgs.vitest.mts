import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const VALIDATOR = path.join(
  process.cwd(),
  'packages/cli/scripts/validate-tui.mjs',
);

function runValidator(
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('TUI validator args', () => {
  it('prints help without building the harness', () => {
    const result = runValidator(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[validate-tui] usage:');
    expect(result.stdout).toContain('--snapshot-dir DIR');
    expect(result.stdout).toContain('--no-build');
    expect(result.stdout).toContain('--skip-if-missing-deps');
    expect(result.stdout).toContain('--list');
    expect(result.stdout).toContain('--list-scenarios');
    expect(result.stdout).toContain('--list-selected');
    expect(result.stdout).toContain('Available scenarios:');
    expect(result.stdout).toContain('nested-subagent-picker');
    expect(result.stderr).not.toContain('building tui-harness bundle');
  });

  it('treats a leading package-manager separator as transparent for help', () => {
    const result = runValidator(['--', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[validate-tui] usage:');
    expect(result.stdout).toContain('Available scenarios:');
    expect(result.stderr).toBe('');
  });

  it('prints scenario names without building the harness', () => {
    const result = runValidator(['--list']);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toContain('transcript');
    expect(result.stdout.split('\n')).toContain('no-color-model-form');
    expect(result.stdout.split('\n')).toContain('nested-subagent-picker');
    expect(result.stdout).not.toContain('Available scenarios:');
    expect(result.stderr).not.toContain('building tui-harness bundle');
  });

  it('treats list-scenarios as a scenario list alias', () => {
    const result = runValidator(['--list-scenarios']);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toContain('transcript');
    expect(result.stdout.split('\n')).toContain('nested-subagent-picker');
    expect(result.stdout).not.toContain('Available scenarios:');
    expect(result.stderr).toBe('');
  });

  it('treats a leading package-manager separator as transparent for list', () => {
    const result = runValidator(['--', '--list']);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toContain('transcript');
    expect(result.stderr).toBe('');
  });

  it('prints selected scenarios in requested order without building the harness', () => {
    const result = runValidator([
      '--list-selected',
      'compact-user-question',
      'plan-approval-goal',
      'slash-palette',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'compact-user-question',
      'plan-approval-goal',
      'slash-palette',
    ]);
    expect(result.stderr).not.toContain('building tui-harness bundle');
  });

  it('parses explicit missing-dependency skip mode before selected scenarios', () => {
    const result = runValidator([
      '--skip-if-missing-deps',
      '--list-selected',
      'compact-user-question',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('compact-user-question');
    expect(result.stderr).toBe('');
  });

  it('parses no-build mode before selected scenarios', () => {
    const result = runValidator([
      '--no-build',
      '--list-selected',
      'compact-user-question',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('compact-user-question');
    expect(result.stderr).toBe('');
  });

  it('fails early when no-build selects a missing custom harness', () => {
    const missingHarness = path.join(
      'dist',
      'bin',
      'definitely-missing-tui-harness.js',
    );
    const result = runValidator(['--no-build', 'compact-user-question'], {
      TEXRA_TUI_HARNESS: missingHarness,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[validate-tui] custom harness does not exist:',
    );
    expect(result.stderr).toContain(path.resolve(missingHarness));
    expect(result.stderr).not.toContain('building tui-harness bundle');
  });

  it('preserves repeated selected scenarios for snapshot order checks', () => {
    const result = runValidator([
      '--list-selected',
      'slash-palette',
      'compact-user-question',
      'slash-palette',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'slash-palette',
      'compact-user-question',
      'slash-palette',
    ]);
    expect(result.stderr).toBe('');
  });

  it('inserts a frame oracle once without deduplicating explicit scenarios', () => {
    const result = runValidator([
      '--list-selected',
      'child-event-order-roster-first',
      'compact-user-question',
      'child-event-order-roster-first',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'child-event-order-canonical',
      'child-event-order-roster-first',
      'compact-user-question',
      'child-event-order-roster-first',
    ]);
    expect(result.stderr).toBe('');
  });

  it('treats a leading package-manager separator as transparent for selected scenarios', () => {
    const result = runValidator([
      '--',
      '--list-selected',
      'plan-approval-goal',
      'compact-user-question',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'plan-approval-goal',
      'compact-user-question',
    ]);
    expect(result.stderr).toBe('');
  });
});
