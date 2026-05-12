// Node.js built-in imports
import { strict as assert } from 'assert';

// Local imports
import { initPlatform, type Platform } from '@platform/platform';
import { BASH_APPROVAL_CONFIG_KEY } from '@tools/approval/bashApproval';
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';
import {
  setSetupPlatform,
  type SetupPlatform,
  type TerminalRunResult,
} from '@tools/setup/platform';

import { createFakeSetupPlatform } from './fixtures';

/**
 * `requestBashApproval` reads `texra.toolUse.requireBashApproval` via
 * `getConfig`, which falls through to its default (`true`) when no
 * platform is registered — so without intervention the approval prompt
 * would emit on the bus and the test would hang waiting for a settle
 * callback that never arrives. Stub the platform's config so the
 * approval flag resolves to `false`.
 *
 * `initPlatform` mutates module-scope state and the platform stays
 * registered for the rest of the mocha process; we don't reset it in an
 * `after` hook because there's no public reset API. That's fine here:
 * the stub returns `defaultValue` verbatim for every key except
 * `BASH_APPROVAL_CONFIG_KEY`, so any test that runs after this file in
 * the same process sees behaviour identical to "no platform registered"
 * unless it also checks the approval flag.
 */
function installApprovalSkippingPlatform(): void {
  const stub: Partial<Platform> = {
    config: {
      get: <T>(key: string, defaultValue?: T): T =>
        key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
      update: async () => {},
      inspect: () => undefined,
      isExplicitlySet: () => false,
      watch: () => ({ dispose: () => {} }),
    },
  };
  initPlatform(stub as Platform);
}

interface RunRecord {
  name: string;
  command: string;
  timeoutMs: number;
}

function createPlatform(
  result: TerminalRunResult = {
    exitCode: 0,
    output: 'installed perl 5.38.2\n',
    timedOut: false,
  },
): { platform: SetupPlatform; runs: RunRecord[] } {
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
  before(() => installApprovalSkippingPlatform());

  it('runs the command and returns exit code + captured output', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
    });

    assert.ok(!result.isError);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'sudo apt-get install -y perl');
    assert.equal(runs[0].name, 'TeXRA: setup');
    assert.match(result.summary ?? '', /exited 0/);
    assert.match(result.output ?? '', /installed perl/);
  });

  it('always prepends TeXRA: to a caller-supplied label', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    await tool.call({
      command: 'sudo apt-get install -y perl',
      label: 'install LaTeX',
    });

    assert.equal(runs[0].name, 'TeXRA: install LaTeX');
  });

  it('reports a non-zero exit code clearly to the agent', async () => {
    const { platform } = createPlatform({
      exitCode: 100,
      output: 'E: Unable to locate package fakepkg\n',
      timedOut: false,
    });
    setSetupPlatform(platform);

    const result = await new SendToTerminalTool().call({
      command: 'sudo apt-get install -y fakepkg',
    });

    assert.ok(!result.isError);
    assert.match(result.summary ?? '', /exited 100/);
    assert.match(result.output ?? '', /Unable to locate package/);
  });

  it('reports a timeout without throwing', async () => {
    const { platform } = createPlatform({
      exitCode: undefined,
      output: 'fetching...\n',
      timedOut: true,
    });
    setSetupPlatform(platform);

    const result = await new SendToTerminalTool().call({
      command: 'sudo apt-get install -y perl',
      timeout: 1000,
    });

    assert.ok(!result.isError);
    assert.match(result.summary ?? '', /timed out/);
  });

  it('rejects commands containing newlines', async () => {
    const { platform, runs } = createPlatform();
    setSetupPlatform(platform);
    const tool = new SendToTerminalTool();

    for (const command of [
      'sudo apt-get install -y perl\nrm -rf /tmp/leak',
      'sudo apt-get install -y perl\r\necho pwned',
      'first\rsecond',
    ]) {
      const result = await tool.call({ command });
      assert.ok(result.isError, `must reject ${JSON.stringify(command)}`);
    }
    assert.equal(runs.length, 0);
  });

  it('truncates from the head, not the tail — the success/error line is at the end', async () => {
    // Output longer than the tool's preview cap. We sentinel the start
    // and end so we can see which side survived truncation.
    const head = 'BEGIN_MARKER\n' + 'x'.repeat(8_000);
    const end = 'Setting up perl ... done\nEND_MARKER';
    const { platform } = createPlatform({
      exitCode: 0,
      output: head + '\n' + end,
      timedOut: false,
    });
    setSetupPlatform(platform);

    const result = await new SendToTerminalTool().call({
      command: 'sudo apt-get install -y perl',
    });

    assert.ok(!result.isError);
    assert.ok(
      (result.output ?? '').includes('END_MARKER'),
      'tail (success line) must survive truncation',
    );
    assert.ok(
      !(result.output ?? '').includes('BEGIN_MARKER'),
      'head must be elided when output exceeds the preview cap',
    );
  });
});
