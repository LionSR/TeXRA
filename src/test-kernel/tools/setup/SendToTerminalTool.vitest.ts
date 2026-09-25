// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports

import type { TerminalRunResult } from '@hosts/uiHosts';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { SendToTerminalTool } from '@tools/setup/SendToTerminalTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

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
  tool: typeof SendToTerminalTool;
  runs: RunRecord[];
  runId: ReturnType<typeof publishTestRunStart>;
}> {
  const runs: RunRecord[] = [];
  await installPlatform(
    {},
    {
      setup: createFakeSetupPlatform({
        terminal: (args) => {
          runs.push(args);
          return Effect.succeed(result);
        },
      }),
    },
  );
  const runId = publishTestRunStart(testDefaultSession());
  await Effect.runPromise(testDefaultSession().settlePublications());
  return { tool: SendToTerminalTool, runs, runId };
}

const callTool = (
  tool: typeof SendToTerminalTool,
  runId: ReturnType<typeof publishTestRunStart>,
  input: unknown,
) =>
  tool.call(input).pipe(
    Effect.provide(
      nativeToolTestLayer({
        run: { runId, session: testDefaultSession(), toolPolicy: {} },
      }),
    ),
  );

describe('SendToTerminalTool', () => {
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
