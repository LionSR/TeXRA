// Node.js built-in imports
import { strict as assert } from 'assert';

// Local imports
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';
import {
  setSetupPlatform,
  type SetupPlatform,
  type TerminalRunResult,
} from '@tools/setup/platform';

import { createFakeSetupPlatform } from './fixtures';

interface RunRecord {
  name: string;
  command: string;
  timeoutMs: number;
}

function createPlatform(
  result: TerminalRunResult = {
    captured: true,
    exitCode: 0,
    output: 'installed perl 5.38.2\n',
    timedOut: false,
  },
): {
  platform: SetupPlatform;
  runs: RunRecord[];
} {
  const runs: RunRecord[] = [];
  const platform = createFakeSetupPlatform({
    terminal: {
      async runCommand(args) {
        runs.push(args);
        return result;
      },
    },
  });
  return { platform, runs };
}

describe('SendToTerminalTool', () => {
  it('runs the command and returns exit code + captured output preview', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: 'sudo password prompt',
    });

    assert.ok(!result.isError);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'sudo apt-get install -y perl');
    assert.equal(
      runs[0].name,
      'TeXRA: setup',
      'default label "setup" must be prefixed with TeXRA:',
    );
    assert.match(result.summary ?? '', /exit 0/);
    assert.match(result.output ?? '', /installed perl/);
    assert.match(result.output ?? '', /sudo password prompt/);
  });

  it('always prepends TeXRA: to a caller-supplied label', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: 'sudo password prompt',
      label: 'install LaTeX',
    });

    assert.equal(
      runs[0].name,
      'TeXRA: install LaTeX',
      'caller-supplied labels must be prefixed, never used as-is',
    );
  });

  it('reports a non-zero exit code clearly to the agent', async () => {
    const { platform } = createPlatform({
      captured: true,
      exitCode: 100,
      output: 'E: Unable to locate package fakepkg\n',
      timedOut: false,
    });
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y fakepkg',
      reason: 'sudo password prompt',
    });

    assert.ok(!result.isError);
    assert.match(result.summary ?? '', /exited 100/);
    assert.match(result.output ?? '', /Unable to locate package/);
  });

  it('handles timeout result without throwing', async () => {
    const { platform } = createPlatform({
      captured: true,
      exitCode: undefined,
      output: 'fetching...\n',
      timedOut: true,
    });
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: 'sudo password prompt',
      timeout: 1000,
    });

    assert.ok(!result.isError);
    assert.match(result.summary ?? '', /timed out/);
    assert.match(result.output ?? '', /did not finish/);
  });

  it('explains the no-capture case when shell integration is unavailable', async () => {
    const { platform } = createPlatform({ captured: false });
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: 'sudo password prompt',
    });

    assert.ok(!result.isError);
    assert.match(result.summary ?? '', /no output capture/);
    assert.match(result.output ?? '', /Shell integration was not available/);
  });

  it('rejects whitespace-only commands', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: '   ',
      reason: 'sudo password prompt',
    });

    assert.ok(result.isError);
    assert.equal(runs.length, 0);
  });

  it('rejects whitespace-only reason — the agent must justify TTY use', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      reason: '   ',
    });

    assert.ok(result.isError);
    assert.equal(runs.length, 0);
  });

  it('rejects commands containing newlines — they would smuggle a second command', async () => {
    const { platform, runs } = createPlatform();
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
    assert.equal(runs.length, 0);
  });

  it('trims surrounding whitespace before sending', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    await tool.call({
      command: '   sudo apt-get install -y perl   ',
      reason: 'sudo password prompt',
    });

    assert.equal(runs[0].command, 'sudo apt-get install -y perl');
  });
});
