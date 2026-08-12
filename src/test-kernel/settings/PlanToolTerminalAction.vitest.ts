// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { planToolTerminalAction } from '@controllers/settingsView/ToolDashboardData';

const mocks = vi.hoisted(() => ({
  packageManager: null as 'brew' | 'apt' | 'scoop' | null,
  isWindows: false,
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return {
    ...actual,
    hasPackageManager: (name: string) => name === mocks.packageManager,
  };
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

const CASES: Array<{
  name: string;
  packageManager?: 'brew' | 'apt' | 'scoop';
  isWindows?: boolean;
  input: Parameters<typeof planToolTerminalAction>[0];
  expected: ReturnType<typeof planToolTerminalAction>;
}> = [
  {
    name: 'plans install terminal actions from tool definitions',
    input: { toolId: 'codex', commandKind: 'install' },
    expected: {
      kind: 'terminal',
      name: 'TeXRA: OpenAI Codex CLI',
      command: 'npm install -g @openai/codex',
    },
  },
  {
    name: 'prefers the package manager that ships the CLI over a global npm install (codex)',
    packageManager: 'brew',
    input: { toolId: 'codex', commandKind: 'install' },
    expected: {
      kind: 'terminal',
      name: 'TeXRA: OpenAI Codex CLI',
      command: 'brew install codex',
    },
  },
  {
    name: 'prefers the package manager that ships the CLI over a global npm install (claude-agent)',
    packageManager: 'brew',
    input: { toolId: 'claude-agent', commandKind: 'install' },
    expected: {
      kind: 'terminal',
      name: 'TeXRA: Claude Code CLI',
      command: 'brew install --cask claude-code',
    },
  },
  {
    // A global npm install leaves only shell shims on Windows, which TeXRA
    // cannot spawn — so Windows wins even when a package manager is present.
    name: 'offers the Windows installer instead of a global npm install',
    packageManager: 'brew',
    isWindows: true,
    input: { toolId: 'claude-agent', commandKind: 'install' },
    expected: {
      kind: 'terminal',
      name: 'TeXRA: Claude Code CLI',
      command: 'winget install Anthropic.ClaudeCode',
    },
  },
  {
    name: 'falls back to npm when the system package manager does not ship the CLI',
    packageManager: 'apt',
    input: { toolId: 'codex', commandKind: 'install' },
    expected: {
      kind: 'terminal',
      name: 'TeXRA: OpenAI Codex CLI',
      command: 'npm install -g @openai/codex',
    },
  },
  {
    name: 'plans auth terminal actions from tool definitions',
    input: { toolId: 'claude-agent', commandKind: 'auth' },
    expected: {
      kind: 'terminal',
      name: 'TeXRA: Claude Code CLI',
      command: 'claude login',
    },
  },
  {
    name: 'does not ask the handler to open a terminal without a command',
    input: { toolId: 'texra-cli', commandKind: 'auth' },
    expected: { kind: 'none', reason: 'missingCommand' },
  },
  {
    name: 'does not plan a terminal action for an unknown tool',
    input: { toolId: 'missing-tool', commandKind: 'install' },
    expected: { kind: 'none', reason: 'unknownTool' },
  },
];

describe('planToolTerminalAction', () => {
  it.each(CASES)('$name', ({ packageManager, isWindows, input, expected }) => {
    mocks.packageManager = packageManager ?? null;
    mocks.isWindows = isWindows ?? false;

    expect(planToolTerminalAction(input)).toEqual(expected);
  });
});
