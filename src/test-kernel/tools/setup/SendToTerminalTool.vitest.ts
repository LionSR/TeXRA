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
import { SendToTerminalTool } from '@texra/tools/setup/SendToTerminalTool';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

interface RunRecord {
  name: string;
  command: string;
  timeoutMs: number;
}

/** Install a host whose terminal runs the case reads back, and start a run. */
async function setupTool(): Promise<{
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
          return Effect.succeed({ exitCode: 0, output: '', timedOut: false });
        },
      }),
    },
  );
  const runId = publishTestRunStart(testDefaultSession());
  await Effect.runPromise(testDefaultSession().log.settled);
  return { runs, runId };
}

const callTool = (
  runId: ReturnType<typeof publishTestRunStart>,
  input: unknown,
) =>
  SendToTerminalTool.call(input).pipe(
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
      const { runs, runId } = yield* Effect.tryPromise(setupTool);

      for (const command of [
        'sudo apt-get install -y perl\nrm -rf /tmp/leak',
        'sudo apt-get install -y perl\r\necho pwned',
        'first\rsecond',
      ]) {
        const result = yield* callTool(runId, { command });
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
