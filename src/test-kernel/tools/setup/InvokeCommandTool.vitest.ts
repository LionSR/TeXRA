// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports
import { AUTH_COMMANDS } from '@auth/constants';
import { InvokeCommandTool } from '@tools/setup/InvokeCommandTool';
import { setSetupPlatform } from '@tools/setup/platform';

import { createFakeSetupPlatform } from './fixtures';

interface InvokeRecord {
  command: string;
  args: unknown[];
}

function setupTool(): { tool: InvokeCommandTool; invocations: InvokeRecord[] } {
  const invocations: InvokeRecord[] = [];
  setSetupPlatform(
    createFakeSetupPlatform({
      commands: {
        async invoke(command, ...args) {
          invocations.push({ command, args });
        },
      },
    }),
  );
  return { tool: new InvokeCommandTool(), invocations };
}

describe('InvokeCommandTool allowlist', () => {
  it('rejects command arguments so credentials cannot reach the host', async () => {
    const { tool, invocations } = setupTool();

    const fakeSecret = 'sk-fake-secret-1234567890abcdef';
    const result = await tool.call({
      command: 'texra.setApiKey',
      args: ['openai', fakeSecret],
    } as never);

    assert.equal(result.status, 'error');
    assert.equal(invocations.length, 0);
  });

  it('allows texra.setApiKey without model-supplied arguments', async () => {
    const { tool, invocations } = setupTool();

    const result = await tool.call({ command: 'texra.setApiKey' });

    assert.equal(result.status, 'executed');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'texra.setApiKey');
    assert.deepEqual(invocations[0].args, []);
  });

  it('allows the Researcher Access sign-in command', async () => {
    const { tool, invocations } = setupTool();

    await tool.call({ command: AUTH_COMMANDS.SIGN_IN });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, AUTH_COMMANDS.SIGN_IN);
  });

  it('rejects workbench.extensions.installExtension (bypass for install_vscode_extension allowlist)', async () => {
    const { tool, invocations } = setupTool();

    const result = await tool.call({
      command: 'workbench.extensions.installExtension',
    });

    assert.equal(result.status, 'error');
    assert.match(
      result.error ?? '',
      /not in the setup allowlist/,
      'error should mention allowlist',
    );
    assert.equal(invocations.length, 0, 'must not invoke the command');
  });

  it('rejects arbitrary VS Code commands outside the allowlist', async () => {
    const { tool, invocations } = setupTool();

    for (const cmd of [
      'workbench.action.files.save',
      'workbench.action.closeAllEditors',
      'editor.action.deleteAllLines',
      'workbench.action.terminal.sendSequence',
      'texra.refreshApiKeyStatus',
      'texra.refreshAllOptions',
    ]) {
      const result = await tool.call({ command: cmd });
      assert.equal(result.status, 'error');
    }
    assert.equal(invocations.length, 0);
  });

  it('rejects empty/whitespace command names', async () => {
    const { tool, invocations } = setupTool();

    const empty = await tool.call({ command: '' });
    assert.equal(empty.status, 'error');
    const blank = await tool.call({ command: '   ' });
    assert.equal(blank.status, 'error');
    assert.equal(invocations.length, 0);
  });

  it('trims surrounding whitespace before allowlist check', async () => {
    const { tool, invocations } = setupTool();

    await tool.call({ command: '  texra.setApiKey  ' });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'texra.setApiKey');
  });
});
