import { describe, expect, it } from 'vitest';

import { executeCommandSync } from '@utils/system/execUtils';

describe('executeCommandSync', () => {
  it('returns normalized stdout for successful commands', () => {
    const result = executeCommandSync([
      process.execPath,
      '-e',
      'process.stdout.write("ok\\n")',
    ]);

    expect(result).toMatchObject({
      success: true,
      stdout: 'ok',
      stderr: null,
      timedOut: false,
      exitCode: 0,
    });
  });

  it('returns stderr and exit code for failing commands', () => {
    const result = executeCommandSync([
      process.execPath,
      '-e',
      'process.stderr.write("bad\\n"); process.exit(7)',
    ]);

    expect(result).toMatchObject({
      success: false,
      stdout: null,
      stderr: 'bad',
      timedOut: false,
      exitCode: 7,
    });
  });
});
