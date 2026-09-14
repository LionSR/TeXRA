// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports
import { defaultSession } from '@agent/runtime/SessionHandle';
import { TERMINAL_OUTPUT_MAX_CHARS } from '@common/terminalOutput';
import type { TerminalRunResult } from '@hosts/uiHosts';
import type { ConfigProvider } from '@platform/interfaces';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';

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
const approvalSkippingConfig: ConfigProvider = {
  get: <T>(key: string, defaultValue?: T): T =>
    key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
  update: async () => {},
  inspect: () => undefined,
  isExplicitlySet: () => false,
};

interface RunRecord {
  name: string;
  command: string;
  timeoutMs: number;
}

async function setupTool(
  result: TerminalRunResult = {
    exitCode: 0,
    output: 'installed perl 5.38.2\n',
    timedOut: false,
  },
): Promise<{
  tool: InstanceType<typeof SendToTerminalTool>;
  runs: RunRecord[];
  runId: ReturnType<typeof publishTestRunStart>;
}> {
  const runs: RunRecord[] = [];
  await installPlatform(
    {},
    {
      config: approvalSkippingConfig,
      setup: createFakeSetupPlatform({
        terminal: {
          async runCommand(args) {
            runs.push(args);
            return result;
          },
        },
      }),
    },
  );
  const runId = publishTestRunStart(defaultSession());
  await defaultSession().settlePublications();
  return { tool: new SendToTerminalTool(), runs, runId };
}

const callTool = (
  tool: InstanceType<typeof SendToTerminalTool>,
  runId: ReturnType<typeof publishTestRunStart>,
  input: unknown,
) =>
  tool.call(input).pipe(
    Effect.provide(
      nativeToolTestLayer({
        run: { runId, session: defaultSession(), toolPolicy: {} },
      }),
    ),
  );

describe('SendToTerminalTool', () => {
  it.effect('advertises the host terminal capture limit', () =>
    Effect.gen(function* () {
      const { tool } = yield* Effect.tryPromise(() => setupTool());
      const description = tool.definition.description;
      assert.ok(description);
      assert.ok(
        description.includes(`up to ${TERMINAL_OUTPUT_MAX_CHARS} characters`),
      );
    }),
  );

  it.effect('runs the command and returns exit code + captured output', () =>
    Effect.gen(function* () {
      const { tool, runs, runId } = yield* Effect.tryPromise(() => setupTool());

      const result = yield* callTool(tool, runId, {
        command: 'sudo apt-get install -y perl',
      });

      assert.equal(result.status, 'executed');
      assert.equal(runs.length, 1);
      assert.equal(runs[0].command, 'sudo apt-get install -y perl');
      assert.equal(runs[0].name, 'TeXRA: setup');
      assert.match(result.summary ?? '', /exited 0/);
      assert.match(result.output ?? '', /installed perl/);
    }),
  );

  it.effect('always prepends TeXRA: to a caller-supplied label', () =>
    Effect.gen(function* () {
      const { tool, runs, runId } = yield* Effect.tryPromise(() => setupTool());

      yield* callTool(tool, runId, {
        command: 'sudo apt-get install -y perl',
        label: 'install LaTeX',
      });

      assert.equal(runs[0].name, 'TeXRA: install LaTeX');
    }),
  );

  it.effect('reports a non-zero exit code clearly to the agent', () =>
    Effect.gen(function* () {
      const { tool, runId } = yield* Effect.tryPromise(() =>
        setupTool({
          exitCode: 100,
          output: 'E: Unable to locate package fakepkg\n',
          timedOut: false,
        }),
      );

      const result = yield* callTool(tool, runId, {
        command: 'sudo apt-get install -y fakepkg',
      });

      assert.equal(result.status, 'executed');
      assert.match(result.summary ?? '', /exited 100/);
      assert.match(result.output ?? '', /Unable to locate package/);
    }),
  );

  it.effect('reports a timeout without throwing', () =>
    Effect.gen(function* () {
      const { tool, runId } = yield* Effect.tryPromise(() =>
        setupTool({
          exitCode: undefined,
          output: 'fetching...\n',
          timedOut: true,
        }),
      );

      const result = yield* callTool(tool, runId, {
        command: 'sudo apt-get install -y perl',
        timeout: 1000,
      });

      assert.equal(result.status, 'executed');
      assert.match(result.summary ?? '', /timed out/);
    }),
  );

  it.effect('rejects commands containing newlines', () =>
    Effect.gen(function* () {
      const { tool, runs, runId } = yield* Effect.tryPromise(() => setupTool());

      for (const command of [
        'sudo apt-get install -y perl\nrm -rf /tmp/leak',
        'sudo apt-get install -y perl\r\necho pwned',
        'first\rsecond',
      ]) {
        const result = yield* callTool(tool, runId, { command });
        assert.equal(
          result.status,
          'error',
          `must reject ${JSON.stringify(command)}`,
        );
      }
      assert.equal(runs.length, 0);
    }),
  );

  it.effect('does not truncate the host-captured terminal tail again', () =>
    Effect.gen(function* () {
      // The host owns its process-level capture bound; the recorder owns the
      // display preview and spill. Keep both sentinels inside the host result.
      const head = 'BEGIN_MARKER\n' + 'x'.repeat(8_000);
      const end = 'Setting up perl ... done\nEND_MARKER';
      const { tool, runId } = yield* Effect.tryPromise(() =>
        setupTool({
          exitCode: 0,
          output: head + '\n' + end,
          timedOut: false,
        }),
      );

      const result = yield* callTool(tool, runId, {
        command: 'sudo apt-get install -y perl',
      });

      assert.equal(result.status, 'executed');
      assert.ok(
        (result.output ?? '').includes('END_MARKER'),
        'the captured tail must be preserved for the recorder',
      );
      assert.ok(
        (result.output ?? '').includes('BEGIN_MARKER'),
        'the captured tail must not be truncated again',
      );
    }),
  );
});
