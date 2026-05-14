import { describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopSetupTerminalModule {
  buildMacTerminalCommand(command: string, cwd: string): string;
  setupCommandNeedsInteractiveTerminal(command: string): boolean;
}

async function loadDesktopSetupTerminal(): Promise<DesktopSetupTerminalModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSetupTerminal.ts'))
  ) as Promise<DesktopSetupTerminalModule>;
}

describe('desktop setup terminal', () => {
  it('detects sudo commands as interactive', async () => {
    const { setupCommandNeedsInteractiveTerminal } =
      await loadDesktopSetupTerminal();

    expect(
      setupCommandNeedsInteractiveTerminal(
        'sudo apt-get install -y texlive-full',
      ),
    ).toBe(true);
    expect(setupCommandNeedsInteractiveTerminal('brew install texlive')).toBe(
      false,
    );
  });

  it('quotes the macOS Terminal working directory before running the command', async () => {
    const { buildMacTerminalCommand } = await loadDesktopSetupTerminal();

    expect(
      buildMacTerminalCommand(
        'brew install texlive',
        "/tmp/TeXRA user's workspace",
      ),
    ).toBe("cd '/tmp/TeXRA user'\\''s workspace' && brew install texlive");
  });
});
