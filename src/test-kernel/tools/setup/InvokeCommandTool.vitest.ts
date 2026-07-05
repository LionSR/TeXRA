// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

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
  it('redacts raw args in summary/output so secrets cannot leak to transcripts', async () => {
    const { tool, invocations } = setupTool();

    const fakeSecret = 'sk-fake-secret-1234567890abcdef';
    const result = await tool.call({
      command: 'texra.setApiKey',
      args: ['openai', fakeSecret],
    });

    assert.equal(result.status, 'executed');
    assert.equal(invocations[0].args.length, 2, 'args still forwarded');
    assert.ok(
      !(result.summary ?? '').includes(fakeSecret),
      'summary must not echo raw args',
    );
    assert.ok(
      !(result.output ?? '').includes(fakeSecret),
      'output must not echo raw args',
    );
    // The tool still acknowledges that args were passed, so the agent
    // can reason about what it just did.
    assert.match(result.summary ?? '', /2 arg\(s\), redacted/);
  });

  it('allows texra.setApiKey and forwards args', async () => {
    const { tool, invocations } = setupTool();

    const result = await tool.call({
      command: 'texra.setApiKey',
      args: ['openai'],
    });

    assert.equal(result.status, 'executed');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'texra.setApiKey');
    assert.deepEqual(invocations[0].args, ['openai']);
  });

  it('allows the Researcher Access sign-in command', async () => {
    const { tool, invocations } = setupTool();

    await tool.call({ command: AUTH_COMMANDS.SIGN_IN, args: [] });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, AUTH_COMMANDS.SIGN_IN);
  });

  it('rejects workbench.extensions.installExtension (bypass for install_vscode_extension allowlist)', async () => {
    const { tool, invocations } = setupTool();

    const result = await tool.call({
      command: 'workbench.extensions.installExtension',
      args: ['ms-python.python'],
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
      const result = await tool.call({ command: cmd, args: [] });
      assert.equal(result.status, 'error');
    }
    assert.equal(invocations.length, 0);
  });

  it('rejects empty/whitespace command names', async () => {
    const { tool, invocations } = setupTool();

    const empty = await tool.call({ command: '', args: [] });
    assert.equal(empty.status, 'error');
    const blank = await tool.call({ command: '   ', args: [] });
    assert.equal(blank.status, 'error');
    assert.equal(invocations.length, 0);
  });

  it('trims surrounding whitespace before allowlist check', async () => {
    const { tool, invocations } = setupTool();

    await tool.call({ command: '  texra.setApiKey  ', args: [] });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'texra.setApiKey');
  });
});
