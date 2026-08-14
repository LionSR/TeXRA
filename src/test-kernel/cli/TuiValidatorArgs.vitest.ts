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

/** --list-selected runs that must succeed with an exact ordered name list. */
function expectSelectedScenarios(args: string[], expected: string[]): void {
  const result = runValidator(args);

  expect(result.status).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(expected);
  expect(result.stderr).toBe('');
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
    expect(result.stdout).toContain('subagent-list-focus-full-frame');
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
    const lines = result.stdout.split('\n');

    expect(result.status).toBe(0);
    expect(lines).toContain('transcript');
    expect(lines).toContain('no-color-model-form');
    expect(lines).toContain('subagent-list-focus-full-frame');
    expect(result.stdout).not.toContain('Available scenarios:');
    expect(result.stderr).not.toContain('building tui-harness bundle');
  });

  it('treats list-scenarios as a scenario list alias', () => {
    const result = runValidator(['--list-scenarios']);
    const lines = result.stdout.split('\n');

    expect(result.status).toBe(0);
    expect(lines).toContain('transcript');
    expect(lines).toContain('subagent-list-focus-full-frame');
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

  it.each(['--skip-if-missing-deps', '--no-build'])(
    'parses %s before selected scenarios',
    (flag) => {
      const result = runValidator([
        flag,
        '--list-selected',
        'compact-user-question',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('compact-user-question');
      expect(result.stderr).toBe('');
    },
  );

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
    expectSelectedScenarios(
      [
        '--list-selected',
        'slash-palette',
        'compact-user-question',
        'slash-palette',
      ],
      ['slash-palette', 'compact-user-question', 'slash-palette'],
    );
  });

  it('inserts a frame oracle once without deduplicating explicit scenarios', () => {
    expectSelectedScenarios(
      [
        '--list-selected',
        'child-event-order-roster-first',
        'compact-user-question',
        'child-event-order-roster-first',
      ],
      [
        'child-event-order-canonical',
        'child-event-order-roster-first',
        'compact-user-question',
        'child-event-order-roster-first',
      ],
    );
  });

  it('treats a leading package-manager separator as transparent for selected scenarios', () => {
    expectSelectedScenarios(
      ['--', '--list-selected', 'plan-approval-goal', 'compact-user-question'],
      ['plan-approval-goal', 'compact-user-question'],
    );
  });
});
