// Node.js built-in imports
import { strict as assert } from 'assert';

// Local imports
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';
import { setSetupPlatform, type SetupPlatform } from '@tools/setup/platform';

interface SendRecord {
  name: string;
  command: string;
  execute: boolean;
}

function createPlatform(): {
  platform: SetupPlatform;
  sends: SendRecord[];
} {
  const sends: SendRecord[] = [];
  const platform: SetupPlatform = {
    secrets: {
      async setApiKey() {},
      async deleteApiKey() {},
      async apiKeyExists() {
        return false;
      },
      async hasUsableApiKey() {
        return false;
      },
      async storedApiKeyExists() {
        return false;
      },
      async anyApiKeyExists() {
        return false;
      },
      async gitHubTokenExists() {
        return 'none';
      },
      providers: [],
    },
    commands: {
      async invoke() {},
    },
    extensions: {
      isInstalled() {
        return false;
      },
      async install() {},
    },
    auth: {
      async getStatus() {
        return { authenticated: false };
      },
    },
    config: {
      get() {
        return undefined;
      },
      async update() {},
    },
    terminal: {
      async sendCommand(args) {
        sends.push(args);
      },
    },
  };
  return { platform, sends };
}

describe('SendToTerminalTool', () => {
  it('types the command without auto-executing by default', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y latexmk',
      reason: 'sudo password prompt',
    });

    assert.ok(!result.isError);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].command, 'sudo apt-get install -y latexmk');
    assert.equal(
      sends[0].execute,
      false,
      'must default to non-executed so the user presses Enter as approval',
    );
    assert.equal(sends[0].name, 'TeXRA: setup');
    assert.match(result.output ?? '', /press Enter/);
    assert.match(result.output ?? '', /sudo password prompt/);
  });

  it('accepts a custom terminal name and execute=true', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'clear',
      reason: 'tidy follow-up',
      name: 'TeXRA: install LaTeX',
      execute: true,
    });

    assert.ok(!result.isError);
    assert.equal(sends[0].name, 'TeXRA: install LaTeX');
    assert.equal(sends[0].execute, true);
    assert.match(result.summary ?? '', /TeXRA: install LaTeX/);
  });

  it('rejects whitespace-only commands', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: '   ',
      reason: 'sudo password prompt',
    });

    assert.ok(result.isError);
    assert.equal(sends.length, 0);
  });

  it('trims surrounding whitespace before sending', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    await tool.call({
      command: '   sudo apt-get install -y perl   ',
      reason: 'sudo password prompt',
    });

    assert.equal(sends[0].command, 'sudo apt-get install -y perl');
  });
});
