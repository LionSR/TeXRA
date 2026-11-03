// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';

// Local imports
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { InvokeCommandTool } from '@texra/tools/setup/InvokeCommandTool';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

interface InvokeRecord {
  command: string;
  args: unknown[];
}

/** Install, for the test's scope, a host whose command invocations the
 *  case reads back. */
const recordInvocations = Effect.gen(function* () {
  const invocations: InvokeRecord[] = [];
  yield* Layer.build(
    FakeHost.layer(
      {},
      {
        setup: createFakeSetupPlatform({
          commands: {
            invoke: (command, ...args) =>
              Effect.sync(() => {
                invocations.push({ command, args });
              }),
          },
        }),
      },
    ),
  );
  return invocations;
});

const invoke = (input: unknown) =>
  InvokeCommandTool.call(input).pipe(
    Effect.provide(withSetup(nativeToolTestLayer())),
  );

layer(SessionGraph.hosted)('InvokeCommandTool allowlist', (it) => {
  it.effect(
    'rejects command arguments so credentials cannot reach the host',
    () =>
      Effect.gen(function* () {
        const invocations = yield* recordInvocations;
        const result = yield* invoke({
          command: 'texra.setApiKey',
          args: ['openai', 'sk-fake-secret-1234567890abcdef'],
        });

        assert.equal(result.status, 'error');
        assert.equal(invocations.length, 0);
      }),
  );

  it.effect('rejects arbitrary VS Code commands outside the allowlist', () =>
    Effect.gen(function* () {
      const invocations = yield* recordInvocations;

      for (const command of [
        // Has its own dedicated tool, so it stays outside this allowlist.
        'workbench.extensions.installExtension',
        'workbench.action.terminal.sendSequence',
        'texra.refreshApiKeyStatus',
      ]) {
        const result = yield* invoke({ command });
        assert.equal(result.status, 'error');
      }
      assert.equal(invocations.length, 0);
    }),
  );
});
