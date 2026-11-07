// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer, Context } from 'effect';

// Local imports
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

/** Build, for the test's scope, a host whose terminal runs the case reads
 *  back, open a session over its roots, start a run on it, and return a
 *  tool call made over that host. */
const setupTool = Effect.gen(function* () {
  const runs: RunRecord[] = [];
  const host = yield* Layer.build(
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
    TestSession.open(Context.get(host, FakeHost).roots, { host: {} }),
    sessionHandleOf,
  );
  const runId = yield* publishTestRunStart(session);
  yield* Context.get(session, SessionLog).settled;
  const callTool = (input: unknown) =>
    SendToTerminalTool.call(input).pipe(
      Effect.provide(
        withSetup(
          nativeToolTestLayer({
            run: { runId, session, toolPolicy: {} },
          }),
        ),
      ),
      Effect.provide(host),
    );
  return { runs, callTool };
});

// Live clock: the session's publisher and readers run on real turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'SendToTerminalTool',
  (it) => {
    it.effect('rejects commands containing newlines', () =>
      Effect.gen(function* () {
        const { runs, callTool } = yield* setupTool;

        for (const command of [
          'sudo apt-get install -y perl\nrm -rf /tmp/leak',
          'sudo apt-get install -y perl\r\necho pwned',
          'first\rsecond',
        ]) {
          const result = yield* callTool({ command });
          assert.equal(
            result.status,
            'error',
            `must reject ${JSON.stringify(command)}`,
          );
          assert.match(
            String(result.error),
            /command must not contain newline \/ carriage-return characters/,
          );
        }
        assert.equal(runs.length, 0);
        // A one-line command reaches the host's terminal: the refusals above
        // were the newlines', not a host without one.
        assert.equal(
          (yield* callTool({ command: 'sudo apt-get install -y perl' })).status,
          'executed',
        );
        assert.deepEqual(
          runs.map(({ command }) => command),
          ['sudo apt-get install -y perl'],
        );
      }),
    );
  },
);
