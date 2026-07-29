// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, vi } from 'vitest';

import { planToolTerminalAction } from '@settingsView/SettingsViewMessageHandler';

const mocks = vi.hoisted(() => ({
  packageManager: null as 'brew' | 'apt' | 'scoop' | null,
  isWindows: false,
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, detectPackageManager: () => mocks.packageManager };
});

vi.mock('@utils/system/platformPaths', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/platformPaths')>();
  return {
    ...actual,
    get IS_WINDOWS() {
      return mocks.isWindows;
    },
  };
});

describe('planToolTerminalAction', () => {
  beforeEach(() => {
    mocks.packageManager = null;
    mocks.isWindows = false;
  });

  it('plans install terminal actions from tool definitions', () => {
    assert.deepEqual(
      planToolTerminalAction({
        toolId: 'codex',
        commandKind: 'install',
      }),
      {
        kind: 'terminal',
        name: 'TeXRA: OpenAI Codex CLI',
        command: 'npm install -g @openai/codex',
      },
    );
  });

  it('prefers the package manager that ships the CLI over a global npm install', () => {
    mocks.packageManager = 'brew';

    assert.deepEqual(
      planToolTerminalAction({ toolId: 'codex', commandKind: 'install' }),
      {
        kind: 'terminal',
        name: 'TeXRA: OpenAI Codex CLI',
        command: 'brew install codex',
      },
    );
    assert.deepEqual(
      planToolTerminalAction({
        toolId: 'claude-agent',
        commandKind: 'install',
      }),
      {
        kind: 'terminal',
        name: 'TeXRA: Claude Code CLI',
        command: 'brew install --cask claude-code',
      },
    );
  });

  it('offers the Windows installer instead of a global npm install', () => {
    // A global npm install leaves only shell shims on Windows, which TeXRA
    // cannot spawn — so Windows wins even when a package manager is present.
    mocks.isWindows = true;
    mocks.packageManager = 'brew';

    assert.deepEqual(
      planToolTerminalAction({
        toolId: 'claude-agent',
        commandKind: 'install',
      }),
      {
        kind: 'terminal',
        name: 'TeXRA: Claude Code CLI',
        command: 'winget install Anthropic.ClaudeCode',
      },
    );
  });

  it('falls back to npm when the system package manager does not ship the CLI', () => {
    mocks.packageManager = 'apt';

    assert.deepEqual(
      planToolTerminalAction({ toolId: 'codex', commandKind: 'install' }),
      {
        kind: 'terminal',
        name: 'TeXRA: OpenAI Codex CLI',
        command: 'npm install -g @openai/codex',
      },
    );
  });

  it('plans auth terminal actions from tool definitions', () => {
    assert.deepEqual(
      planToolTerminalAction({
        toolId: 'claude-agent',
        commandKind: 'auth',
      }),
      {
        kind: 'terminal',
        name: 'TeXRA: Claude Code CLI',
        command: 'claude login',
      },
    );
  });

  it('does not ask the handler to open a terminal without a command', () => {
    assert.deepEqual(
      planToolTerminalAction({
        toolId: 'texra-cli',
        commandKind: 'auth',
      }),
      { kind: 'none', reason: 'missingCommand' },
    );

    assert.deepEqual(
      planToolTerminalAction({
        toolId: 'missing-tool',
        commandKind: 'install',
      }),
      { kind: 'none', reason: 'unknownTool' },
    );
  });
});
