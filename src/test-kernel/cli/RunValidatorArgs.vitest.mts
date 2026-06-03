import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const VALIDATOR = path.join(
  process.cwd(),
  'packages/cli/scripts/validate-run.mjs',
);

function runValidator(args: string[]) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('CLI run validator args', () => {
  it('prints help without building the CLI bundle', () => {
    const result = runValidator(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[validate-run] usage:');
    expect(result.stdout).toContain('--no-build');
    expect(result.stderr).not.toContain('building');
  });

  it('rejects unknown options before running validation', () => {
    const result = runValidator(['--definitely-missing']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '[validate-run] unknown argument: --definitely-missing',
    );
    expect(result.stderr).toContain('[validate-run] usage:');
  });
});
