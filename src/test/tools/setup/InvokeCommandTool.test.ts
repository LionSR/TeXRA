// Node.js built-in imports
import { strict as assert } from 'assert';

// Local imports
import { AUTH_COMMANDS } from '@auth/constants';
import { InvokeCommandTool } from '@tools/setup/InvokeCommandTool';
import { setSetupPlatform, type SetupPlatform } from '@tools/setup/platform';

import { createFakeSetupPlatform } from './fixtures';

interface InvokeRecord {
  command: string;
  args: unknown[];
}

function createPlatform(): {
  platform: SetupPlatform;
  invocations: InvokeRecord[];
} {
  const invocations: InvokeRecord[] = [];
  const platform = createFakeSetupPlatform({
    commands: {
      async invoke(command, ...args) {
        invocations.push({ command, args });
      },
    },
  });
  return { platform, invocations };
}

describe('InvokeCommandTool allowlist', () => {
  it('redacts raw args in summary/output so secrets cannot leak to transcripts', async () => {
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    const fakeSecret = 'sk-fake-secret-1234567890abcdef';
    const result = await tool.call({
      command: 'texra.setApiKey',
      args: ['openai', fakeSecret],
    });

    assert.ok(!result.isError);
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
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    const result = await tool.call({
      command: 'texra.setApiKey',
      args: ['openai'],
    });

    assert.ok(!('isError' in result) || !result.isError, 'should not error');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'texra.setApiKey');
    assert.deepEqual(invocations[0].args, ['openai']);
  });

  it('allows the Researcher Access sign-in command', async () => {
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    await tool.call({ command: AUTH_COMMANDS.SIGN_IN, args: [] });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, AUTH_COMMANDS.SIGN_IN);
  });

  it('rejects workbench.extensions.installExtension (bypass for install_vscode_extension allowlist)', async () => {
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    const result = await tool.call({
      command: 'workbench.extensions.installExtension',
      args: ['ms-python.python'],
    });

    assert.ok(result.isError, 'should report an error');
    assert.match(
      result.error ?? '',
      /not in the setup allowlist/,
      'error should mention allowlist',
    );
    assert.equal(invocations.length, 0, 'must not invoke the command');
  });

  it('rejects arbitrary VS Code commands outside the allowlist', async () => {
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    for (const cmd of [
      'workbench.action.files.save',
      'workbench.action.closeAllEditors',
      'editor.action.deleteAllLines',
      'workbench.action.terminal.sendSequence',
    ]) {
      const result = await tool.call({ command: cmd, args: [] });
      assert.ok(result.isError, `${cmd} should be rejected`);
    }
    assert.equal(invocations.length, 0);
  });

  it('rejects empty/whitespace command names', async () => {
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    const empty = await tool.call({ command: '', args: [] });
    assert.ok(empty.isError);
    const blank = await tool.call({ command: '   ', args: [] });
    assert.ok(blank.isError);
    assert.equal(invocations.length, 0);
  });

  it('trims surrounding whitespace before allowlist check', async () => {
    const { platform, invocations } = createPlatform();
    setSetupPlatform(platform);
    const tool = new InvokeCommandTool();

    await tool.call({ command: '  texra.setApiKey  ', args: [] });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'texra.setApiKey');
  });
});
