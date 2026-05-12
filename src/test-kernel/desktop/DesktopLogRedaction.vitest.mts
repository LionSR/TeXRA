// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopLogRedactionModule {
  redactDesktopLog(
    text: string,
    options?: { homeDir?: string; workspacePath?: string },
  ): string;
}

async function loadDesktopLogRedaction(): Promise<DesktopLogRedactionModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopLogRedaction.ts'))
  ) as Promise<DesktopLogRedactionModule>;
}

describe('desktop log redaction', () => {
  it('redacts obvious secrets and sensitive path prefixes', async () => {
    const { redactDesktopLog } = await loadDesktopLogRedaction();

    const redacted = redactDesktopLog(
      [
        'OPENAI_API_KEY=sk-1234567890abcdef',
        'Authorization: Bearer ghp_1234567890abcdef',
        '/Users/alice/private-paper/main.tex',
        '/Users/alice/.config/texra',
      ].join('\n'),
      {
        homeDir: '/Users/alice',
        workspacePath: '/Users/alice/private-paper',
      },
    );

    expect(redacted).not.toContain('sk-1234567890abcdef');
    expect(redacted).not.toContain('ghp_1234567890abcdef');
    expect(redacted).not.toContain('/Users/alice/private-paper');
    expect(redacted).not.toContain('/Users/alice/.config');
    expect(redacted).toContain('OPENAI_API_KEY=[redacted]');
    expect(redacted).toContain('Bearer [redacted]');
    expect(redacted).toContain('[path]/main.tex');
  });
});
