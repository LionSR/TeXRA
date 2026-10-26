// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports

import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import type { TerminalRunResult } from '@texra/hosts/uiHosts';
import { SendToTerminalTool } from '@texra/tools/setup/SendToTerminalTool';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

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
  await Effect.runPromise(testDefaultSession().log.settled);
  return { tool: SendToTerminalTool, runs, runId };
}

const callTool = (
  tool: typeof SendToTerminalTool,
  runId: ReturnType<typeof publishTestRunStart>,
  input: unknown,
) =>
  tool.call(input).pipe(
    Effect.provide(
      withSetup(
        nativeToolTestLayer({
          run: { runId, session: testDefaultSession(), toolPolicy: {} },
        }),
      ),
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
});
