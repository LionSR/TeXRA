// Third-party imports
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  EXTENSION_COMMAND_HANDLERS,
  type ExtensionCommandActions,
} from '@commands/extensionCommandHandlers';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';

// `extensionCommandHandlers.ts` is deliberately free of `vscode` imports, so
// the production handler map is exercised directly here. Only
// `extensionCommandSurface.ts`, which wires the real actions against VS Code
// APIs, needs the extension host.

function asyncNoop() {
  return vi.fn(() => Effect.void);
}

function makeActions(): ExtensionCommandActions {
  return {
    showSettings: asyncNoop(),
    newTask: asyncNoop(),
    cleanBuild: asyncNoop(),
    pack: asyncNoop(),
    clean: asyncNoop(),
    compare: asyncNoop(),
    acceptEdited: vi.fn(() => Effect.succeed(true)),
    signIn: vi.fn(() => Effect.succeed(false)),
    signInChatGpt: asyncNoop(),
    signOut: asyncNoop(),
    runSetupAssistant: asyncNoop(),
    openGettingStarted: asyncNoop(),
    createSampleProject: asyncNoop(),
    downloadArXivSource: asyncNoop(),
    openProgressViewInTab: asyncNoop(),
    openDoc: asyncNoop(),
    indentCurrentTeX: asyncNoop(),
    fixCompilation: asyncNoop(),
    getTeXCount: asyncNoop(),
    extractTikzFigures: asyncNoop(),
    compileTikzFigures: asyncNoop(),
    cloneOverleafProject: asyncNoop(),
    removeApiKey: asyncNoop(),
    showProgressView: asyncNoop(),
    setApiKey: asyncNoop(),
    createAgentWithAI: asyncNoop(),
    execute: asyncNoop(),
  };
}

// Settles the handler's program the way the registration boundary does
// (the test programs need no services), or `false` when dispatch refuses.
function dispatch(
  actions: ExtensionCommandActions,
  id: keyof typeof EXTENSION_COMMAND_HANDLERS,
  ...args: unknown[]
): Promise<unknown> {
  const program = dispatchCommandFromRegistry(
    id,
    EXTENSION_COMMAND_HANDLERS,
    actions,
    undefined,
    ...args,
  );
  return program === false
    ? Promise.resolve(false)
    : Effect.runPromise(program as Effect.Effect<unknown, Error>);
}

describe('extension command surface — catalog-tagged command dispatch', () => {
  describe('typed file-operation arguments', () => {
    const BASE_FILE = {
      kind: 'external' as const,
      absolutePath: '/tmp/base.tex',
    };
    const EDITED_FILE = {
      kind: 'external' as const,
      absolutePath: '/tmp/edited.tex',
    };
    const COPY_META = { agent: 'editor', model: 'gpt-5', round: 2 };

    it('normalizes and forwards pack/clean config objects', async () => {
      const actions = makeActions();
      const config = {
        inputFile: 'main.tex',
        agent: 'editor',
        model: 'gpt-5',
      };

      await expect(
        dispatch(actions, 'texra.pack', config),
      ).resolves.toBeUndefined();
      await expect(
        dispatch(actions, 'texra.clean', config),
      ).resolves.toBeUndefined();
      expect(actions.pack).toHaveBeenCalledExactlyOnceWith({
        ...config,
        outputFiles: [],
      });
      expect(actions.clean).toHaveBeenCalledExactlyOnceWith({
        ...config,
        outputFiles: [],
      });
    });

    it('forwards compare and accept arguments without collapsing them', async () => {
      const actions = makeActions();

      await expect(
        dispatch(actions, 'texra.compare', BASE_FILE, EDITED_FILE),
      ).resolves.toBeUndefined();
      await expect(
        dispatch(
          actions,
          'texra.acceptEdited',
          BASE_FILE,
          EDITED_FILE,
          COPY_META,
        ),
      ).resolves.toBe(true);
      expect(actions.compare).toHaveBeenCalledExactlyOnceWith(
        BASE_FILE,
        EDITED_FILE,
      );
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        BASE_FILE,
        EDITED_FILE,
        COPY_META,
      );
    });
  });

  it.each([null, true, 'true', { inPlace: 'true' }, { extra: true }])(
    'texra.showProgressView rejects malformed argument %j',
    async (argument) => {
      const actions = makeActions();
      await expect(
        dispatch(actions, 'texra.showProgressView', argument),
      ).resolves.toBe(false);
      expect(actions.showProgressView).not.toHaveBeenCalled();
    },
  );

  it('texra.setApiKey rejects unknown provider', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.setApiKey', 'not-a-provider'),
    ).resolves.toBe(false);
    expect(actions.setApiKey).not.toHaveBeenCalled();
  });

  // Regression guard for #3782: handlers must propagate async rejections
  // instead of swallowing them through `void actions.X(); return true;`.
  // Each asserted handler returns a failing program, and settling it must
  // surface that same rejection to VS Code's `executeCommand` callers.
  describe('async rejection propagation (regression guard for #3782)', () => {
    it.each([
      ['texra.auth.signIn', 'signIn'],
      ['texra.showMemory', 'showSettings'],
      ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    ] as const)('%s rejection bubbles up', async (id, actionKey) => {
      const actions = makeActions();
      const failure = new Error(`boom-${actionKey}`);

      (actions[actionKey] as any).mockReturnValueOnce(Effect.fail(failure));

      await expect(dispatch(actions, id)).rejects.toBe(failure);
    });
  });
});
