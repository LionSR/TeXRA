// Third-party imports
import { describe, expect, it } from 'vitest';

import { type DoctorReport, writeDoctorReport } from '@cli/runtime/doctor';
import type { CliContext } from '@cli/runtime/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const context: CliContext = createTestCliContext({
  cwd: '/workspace',
  resourcesPath: '/resources',
});

function captureDoctorStdout(
  writeContext: CliContext,
  report: DoctorReport,
): string {
  let stdout = '';
  const stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
    stdout += chunk;
  });

  try {
    writeDoctorReport(writeContext, report);
  } finally {
    stdoutSpy.mockRestore();
  }

  return stdout;
}

describe('CLI doctor', () => {
  it('redacts email-like values in check messages and hints', () => {
    const report: DoctorReport = {
      ok: true,
      checks: [
        {
          id: 'config',
          name: 'Config',
          status: 'warn',
          message: 'Workspace config references owner@example.edu.',
          hint: 'Ask admin@example.edu to update it.',
        },
      ],
    };

    const text = captureDoctorStdout(context, report);

    expect(text).toContain('Workspace config references o***@e***.edu.');
    expect(text).toContain('Ask a***@e***.edu to update it.');
    expect(text).not.toContain('owner@example.edu');
    expect(text).not.toContain('admin@example.edu');
  });
});
