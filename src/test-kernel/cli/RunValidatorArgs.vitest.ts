import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const VALIDATOR = path.join(
  process.cwd(),
  'packages/cli/scripts/validate-run.mjs',
);
const BINARY = path.join(process.cwd(), 'packages/cli/dist/bin/texra.js');
const VALIDATION_BINARY = path.join(
  process.cwd(),
  'packages/cli/.texra-validate-run/bin/texra.js',
);

function fileMtime(filePath: string) {
  return existsSync(filePath) ? statSync(filePath).mtimeMs : undefined;
}

function bundleMtimes() {
  return {
    production: fileMtime(BINARY),
    validation: fileMtime(VALIDATION_BINARY),
  };
}

function runValidator(args: string[]) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function runValidatorWithoutRebuild(args: string[]) {
  const before = bundleMtimes();
  const result = runValidator(args);
  expect(bundleMtimes()).toEqual(before);
  return result;
}

describe('CLI run validator args', () => {
  it('prints help without building the CLI bundle', () => {
    const result = runValidatorWithoutRebuild(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[validate-run] usage:');
    expect(result.stdout).toContain('--no-build');
  });

  it('rejects unknown options before running validation', () => {
    const result = runValidatorWithoutRebuild(['--definitely-missing']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '[validate-run] unknown argument: --definitely-missing',
    );
    expect(result.stderr).toContain('[validate-run] usage:');
  });
});
