// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports
import { AUTH_COMMANDS } from '@auth/constants';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { InvokeCommandTool } from '@tools/setup/InvokeCommandTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

interface InvokeRecord {
  command: string;
  args: unknown[];
}

async function setupTool(): Promise<{
  tool: InvokeCommandTool;
  invocations: InvokeRecord[];
}> {
  const invocations: InvokeRecord[] = [];
  await installPlatform(
    {},
    {
      setup: createFakeSetupPlatform({
        commands: {
          async invoke(command, ...args) {
            invocations.push({ command, args });
          },
        },
      }),
    },
  );
  return { tool: new InvokeCommandTool(), invocations };
}

const invoke = (tool: InvokeCommandTool, input: unknown) =>
  tool.call(input).pipe(Effect.provide(nativeToolTestLayer()));

describe('InvokeCommandTool allowlist', () => {
  it.effect(
    'rejects command arguments so credentials cannot reach the host',
    () =>
      Effect.gen(function* () {
        const { tool, invocations } = yield* Effect.tryPromise(() =>
          setupTool(),
        );
        const result = yield* invoke(tool, {
          command: 'texra.setApiKey',
          args: ['openai', 'sk-fake-secret-1234567890abcdef'],
        });

        assert.equal(result.status, 'error');
        assert.equal(invocations.length, 0);
      }),
  );

  it.effect('allows texra.setApiKey without model-supplied arguments', () =>
    Effect.gen(function* () {
      const { tool, invocations } = yield* Effect.tryPromise(() => setupTool());
      const result = yield* invoke(tool, { command: 'texra.setApiKey' });

      assert.equal(result.status, 'executed');
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].command, 'texra.setApiKey');
      assert.deepEqual(invocations[0].args, []);
    }),
  );

  it.effect('allows the TeXRA account sign-in command', () =>
    Effect.gen(function* () {
      const { tool, invocations } = yield* Effect.tryPromise(() => setupTool());
      yield* invoke(tool, { command: AUTH_COMMANDS.SIGN_IN });

      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].command, AUTH_COMMANDS.SIGN_IN);
    }),
  );

  it.effect(
    'rejects workbench.extensions.installExtension outside its dedicated tool',
    () =>
      Effect.gen(function* () {
        const { tool, invocations } = yield* Effect.tryPromise(() =>
          setupTool(),
        );
        const result = yield* invoke(tool, {
          command: 'workbench.extensions.installExtension',
        });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /not in the setup allowlist/);
        assert.equal(invocations.length, 0);
      }),
  );

  it.effect('rejects arbitrary VS Code commands outside the allowlist', () =>
    Effect.gen(function* () {
      const { tool, invocations } = yield* Effect.tryPromise(() => setupTool());

      for (const command of [
        'workbench.action.files.save',
        'workbench.action.closeAllEditors',
        'editor.action.deleteAllLines',
        'workbench.action.terminal.sendSequence',
        'texra.refreshApiKeyStatus',
        'texra.refreshAllOptions',
      ]) {
        const result = yield* invoke(tool, { command });
        assert.equal(result.status, 'error');
      }
      assert.equal(invocations.length, 0);
    }),
  );

  it.effect('rejects empty or whitespace command names', () =>
    Effect.gen(function* () {
      const { tool, invocations } = yield* Effect.tryPromise(() => setupTool());
      const empty = yield* invoke(tool, { command: '' });
      const blank = yield* invoke(tool, { command: '   ' });

      assert.equal(empty.status, 'error');
      assert.equal(blank.status, 'error');
      assert.equal(invocations.length, 0);
    }),
  );

  it.effect('trims surrounding whitespace before allowlist check', () =>
    Effect.gen(function* () {
      const { tool, invocations } = yield* Effect.tryPromise(() => setupTool());
      yield* invoke(tool, { command: '  texra.setApiKey  ' });

      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].command, 'texra.setApiKey');
    }),
  );
});
