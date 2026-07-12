// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { planToolTerminalAction } from '@settingsView/SettingsViewMessageHandler';

describe('planToolTerminalAction', () => {
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
