// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer, Context } from 'effect';

// Local imports

import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { SendToTerminalTool } from '@texra/tools/setup/SendToTerminalTool';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

interface RunRecord {
  name: string;
  command: string;
  timeoutMs: number;
}

/** Install, for the test's scope, a host whose terminal runs the case
 *  reads back, open a session over its roots, and start a run on it. */
const setupTool = Effect.gen(function* () {
  const runs: RunRecord[] = [];
  yield* Layer.build(
    FakeHost.layer(
      {},
      {
        setup: createFakeSetupPlatform({
          terminal: (args) => {
            runs.push(args);
            return Effect.succeed({ exitCode: 0, output: '', timedOut: false });
          },
        }),
      },
    ),
  );
  const session = yield* Effect.flatMap(
    TestSession.open(undefined, { host: {} }),
    sessionHandleOf,
  );
  const runId = publishTestRunStart(session);
  yield* Context.get(session, SessionLog).settled;
  return { runs, session, runId };
});

const callTool = (
  session: Context.Context<SessionServices>,
  runId: ReturnType<typeof publishTestRunStart>,
  input: unknown,
) =>
  SendToTerminalTool.call(input).pipe(
    Effect.provide(
      withSetup(
        nativeToolTestLayer({
          run: { runId, session, toolPolicy: {} },
        }),
      ),
    ),
  );

// Live clock: the session's publisher and readers run on real turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'SendToTerminalTool',
  (it) => {
    it.effect('rejects commands containing newlines', () =>
      Effect.gen(function* () {
        const { runs, session, runId } = yield* setupTool;

        for (const command of [
          'sudo apt-get install -y perl\nrm -rf /tmp/leak',
          'sudo apt-get install -y perl\r\necho pwned',
          'first\rsecond',
        ]) {
          const result = yield* callTool(session, runId, { command });
          assert.equal(
            result.status,
            'error',
            `must reject ${JSON.stringify(command)}`,
          );
        }
        assert.equal(runs.length, 0);
      }),
    );
  },
);
