import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const VALIDATOR = path.join(
  process.cwd(),
  'packages/cli/scripts/validate-tui.mjs',
);

function runValidator(args: string[]) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('TUI validator args', () => {
  it('prints help without building the harness', () => {
    const result = runValidator(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[validate-tui] usage:');
    expect(result.stdout).toContain('--snapshot-dir DIR');
    expect(result.stdout).toContain('--list');
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
    expect(result.stdout.split('\n')).toContain('nested-subagent-picker');
    expect(result.stdout).not.toContain('Available scenarios:');
    expect(result.stderr).not.toContain('building tui-harness bundle');
  });

  it('treats a leading package-manager separator as transparent for list', () => {
    const result = runValidator(['--', '--list']);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toContain('transcript');
    expect(result.stderr).toBe('');
  });
});
