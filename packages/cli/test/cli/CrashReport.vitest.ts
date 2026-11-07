import { afterEach, describe, expect, it, vi } from 'vitest';

// The crash formatter runs inside the CLI's last-resort error handler, so it
// must not throw even when the manifest it reads is what broke the process.
describe('formatCrashReportLine', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reports no tracker line, without throwing, when the manifest does not decode', async () => {
    vi.stubEnv('TEXRA_CLI_MANIFEST', '{"version":""}');
    vi.resetModules();
    const { formatCrashReportLine } =
      await import('@cli/runtime/platform/cliContext');
    expect(formatCrashReportLine(new Error('unexpected'))).toBeUndefined();
  });
});
