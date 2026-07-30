// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, beforeAll } from 'vitest';

// Local imports
import type { ConfigProvider } from '@platform/interfaces';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { installPlatform } from '@test/support/setupPlatform';
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';
import {
  setSetupPlatform,
  type TerminalRunResult,
} from '@tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

/**
 * `requestBashApproval` reads `texra.toolUse.requireBashApproval` via
 * `getConfig`, which falls through to its default (`true`) when no
 * platform is registered — so without intervention the approval prompt
 * would emit on the bus and the test would hang waiting for a settle
 * callback that never arrives. Stub the platform's config so the
 * approval flag resolves to `false`.
 *
 * The stub returns `defaultValue` verbatim for every key except
 * `BASH_APPROVAL_CONFIG_KEY`, so behaviour stays identical to "no platform
 * registered" unless a test also checks the approval flag.
 */
async function installApprovalSkippingPlatform(): Promise<void> {
  const stubConfig: ConfigProvider = {
    get: <T>(key: string, defaultValue?: T): T =>
      key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
    update: async () => {},
    inspect: () => undefined,
    isExplicitlySet: () => false,
    watch: () => ({ dispose: () => {} }),
  };
  await installPlatform({}, { config: stubConfig });
}

interface RunRecord {
  name: string;
  command: string;
  timeoutMs: number;
}

function setupTool(
  result: TerminalRunResult = {
    exitCode: 0,
    output: 'installed perl 5.38.2\n',
    timedOut: false,
  },
): { tool: SendToTerminalTool; runs: RunRecord[] } {
  const runs: RunRecord[] = [];
  setSetupPlatform(
    createFakeSetupPlatform({
      terminal: {
        async runCommand(args) {
          runs.push(args);
          return result;
        },
      },
    }),
  );
  return { tool: new SendToTerminalTool(), runs };
}

describe('SendToTerminalTool', () => {
  beforeAll(() => installApprovalSkippingPlatform());

  it('runs the command and returns exit code + captured output', async () => {
    const { tool, runs } = setupTool();

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
    });

    assert.equal(result.status, 'executed');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'sudo apt-get install -y perl');
    assert.equal(runs[0].name, 'TeXRA: setup');
    assert.match(result.summary ?? '', /exited 0/);
    assert.match(result.output ?? '', /installed perl/);
  });

  it('always prepends TeXRA: to a caller-supplied label', async () => {
    const { tool, runs } = setupTool();

    await tool.call({
      command: 'sudo apt-get install -y perl',
      label: 'install LaTeX',
    });

    assert.equal(runs[0].name, 'TeXRA: install LaTeX');
  });

  it('reports a non-zero exit code clearly to the agent', async () => {
    const { tool } = setupTool({
      exitCode: 100,
      output: 'E: Unable to locate package fakepkg\n',
      timedOut: false,
    });

    const result = await tool.call({
      command: 'sudo apt-get install -y fakepkg',
    });

    assert.equal(result.status, 'executed');
    assert.match(result.summary ?? '', /exited 100/);
    assert.match(result.output ?? '', /Unable to locate package/);
  });

  it('reports a timeout without throwing', async () => {
    const { tool } = setupTool({
      exitCode: undefined,
      output: 'fetching...\n',
      timedOut: true,
    });

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
      timeout: 1000,
    });

    assert.equal(result.status, 'executed');
    assert.match(result.summary ?? '', /timed out/);
  });

  it('rejects commands containing newlines', async () => {
    const { tool, runs } = setupTool();

    for (const command of [
      'sudo apt-get install -y perl\nrm -rf /tmp/leak',
      'sudo apt-get install -y perl\r\necho pwned',
      'first\rsecond',
    ]) {
      const result = await tool.call({ command });
      assert.equal(
        result.status,
        'error',
        `must reject ${JSON.stringify(command)}`,
      );
    }
    assert.equal(runs.length, 0);
  });

  it('truncates from the head, not the tail — the success/error line is at the end', async () => {
    // Output longer than the tool's preview cap. We sentinel the start
    // and end so we can see which side survived truncation.
    const head = 'BEGIN_MARKER\n' + 'x'.repeat(8_000);
    const end = 'Setting up perl ... done\nEND_MARKER';
    const { tool } = setupTool({
      exitCode: 0,
      output: head + '\n' + end,
      timedOut: false,
    });

    const result = await tool.call({
      command: 'sudo apt-get install -y perl',
    });

    assert.equal(result.status, 'executed');
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
