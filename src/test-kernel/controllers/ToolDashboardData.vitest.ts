import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { buildToolDashboardTerminalAction } from '@controllers/settingsView/ToolDashboardData';

describe('ToolDashboardData', () => {
  it('plans install terminal actions from tool definitions', () => {
    assert.deepEqual(
      buildToolDashboardTerminalAction({
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
      buildToolDashboardTerminalAction({
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
      buildToolDashboardTerminalAction({
        toolId: 'texra-cli',
        commandKind: 'auth',
      }),
      { kind: 'none', reason: 'missingCommand' },
    );

    assert.deepEqual(
      buildToolDashboardTerminalAction({
        toolId: 'missing-tool',
        commandKind: 'install',
      }),
      { kind: 'none', reason: 'unknownTool' },
    );
  });
});
