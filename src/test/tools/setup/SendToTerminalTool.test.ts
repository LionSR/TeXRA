// Node.js built-in imports
import { strict as assert } from 'assert';

// Local imports
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';
import { setSetupPlatform, type SetupPlatform } from '@tools/setup/platform';

interface SendRecord {
  name: string;
  command: string;
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
  it('types the command and prepends TeXRA: to the default label', async () => {
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
      sends[0].name,
      'TeXRA: setup',
      'default label "setup" must be prefixed with TeXRA:',
    );
    assert.match(result.output ?? '', /press Enter/);
    assert.match(result.output ?? '', /sudo password prompt/);
  });

  it('always prepends TeXRA: to a caller-supplied label', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: 'sudo password prompt',
      label: 'install LaTeX',
    });

    assert.ok(!result.isError);
    assert.equal(
      sends[0].name,
      'TeXRA: install LaTeX',
      'caller-supplied labels must be prefixed, never used as-is',
    );
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

  it('rejects commands containing newlines — they would auto-execute past Enter', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    for (const command of [
      'sudo apt-get install -y perl\nrm -rf /tmp/leak',
      'sudo apt-get install -y perl\r\necho pwned',
      'first\rsecond',
    ]) {
      const result = await tool.call({
        command,
        reason: 'sudo password prompt',
      });
      assert.ok(
        result.isError,
        `embedded newline must be rejected: ${JSON.stringify(command)}`,
      );
    }
    assert.equal(sends.length, 0, 'no sends should reach the platform');
  });

  it('rejects whitespace-only reason — the agent must justify TTY use', async () => {
    const { platform, sends } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: '   ',
    });

    assert.ok(result.isError, 'whitespace-only reason must fail validation');
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

  it('redacts the full command from the transcript output for long commands', async () => {
    const { platform } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const longSecret = 'sudo apt-get install -y ' + 'x'.repeat(200);
    const result = await tool.call({
      command: longSecret,
      reason: 'sudo password prompt',
    });

    assert.ok(!result.isError);
    assert.ok(
      !(result.output ?? '').includes(longSecret),
      'output must not echo the full command verbatim',
    );
    // A truncated preview is fine; the bracketed full string is not.
    assert.match(result.output ?? '', /preview/);
  });
});
