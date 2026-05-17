// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

function readDesktopMain(): string {
  return readFileSync(repoPath('packages/desktop/src/main/index.ts'), 'utf8');
}

describe('desktop setup terminal main process', () => {
  it('always cleans up captured setup commands and reports thrown failures', () => {
    const desktopMain = readDesktopMain();

    expect(desktopMain).toContain('setupCommandExceptionResult(error)');
    expect(desktopMain).toContain('finally {');
    expect(desktopMain).toContain('activeSetupCommands.delete(runId);');
    expect(desktopMain).toContain('buildDesktopSetupTerminalCompleteMessage({');
  });
});
