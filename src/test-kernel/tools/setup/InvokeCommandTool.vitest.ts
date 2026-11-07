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

/** A host whose command invocations the case reads back, built for the
 *  test's scope, and a tool call made over that host. */
const recordingHost = Effect.gen(function* () {
  const invocations: InvokeRecord[] = [];
  const host = yield* Layer.build(
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
  const invoke = (input: unknown) =>
    InvokeCommandTool.call(input).pipe(
      Effect.provide(withSetup(nativeToolTestLayer())),
      Effect.provide(host),
    );
  return { invocations, invoke };
});

layer(SessionGraph.hosted)('InvokeCommandTool allowlist', (it) => {
  it.effect(
    'rejects command arguments so credentials cannot reach the host',
    () =>
      Effect.gen(function* () {
        const { invocations, invoke } = yield* recordingHost;
        const result = yield* invoke({
          command: 'texra.setApiKey',
          args: ['openai', 'sk-fake-secret-1234567890abcdef'],
        });

        assert.equal(result.status, 'error');
        assert.equal(invocations.length, 0);
        // The same command without arguments reaches the host: the refusal
        // above was the arguments', not a host that cannot invoke.
        assert.equal(
          (yield* invoke({ command: 'texra.setApiKey' })).status,
          'executed',
        );
        assert.deepEqual(invocations, [
          { command: 'texra.setApiKey', args: [] },
        ]);
      }),
  );

  it.effect('rejects arbitrary VS Code commands outside the allowlist', () =>
    Effect.gen(function* () {
      const { invocations, invoke } = yield* recordingHost;

      for (const command of [
        // Has its own dedicated tool, so it stays outside this allowlist.
        'workbench.extensions.installExtension',
        'workbench.action.terminal.sendSequence',
        'texra.refreshApiKeyStatus',
      ]) {
        const result = yield* invoke({ command });
        assert.equal(result.status, 'error');
        assert.match(
          String(result.error),
          new RegExp(`^Command "${command}" is not in the setup allowlist\\.`),
        );
      }
      assert.equal(invocations.length, 0);
    }),
  );
});
