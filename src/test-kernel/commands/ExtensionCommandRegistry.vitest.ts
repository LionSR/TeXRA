// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  EXTENSION_COMMAND_HANDLERS,
  EXTENSION_INTERNAL_COMMAND_IDS,
  type ExtensionCommandActions,
} from '@commands/extensionCommandHandlers';
import {
  commandCatalog,
  type CommandCatalogEntry,
} from '@shared/commands/catalog';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';

// `extensionCommandHandlers.ts` is deliberately free of `vscode` imports, so
// the production handler map is exercised directly here. Only
// `extensionCommandSurface.ts`, which wires the real actions against VS Code
// APIs, needs the extension host.

// Catalog ids tagged `extensionRegistry: true`, derived here rather than
// mirrored in production: `EXTENSION_COMMAND_HANDLERS` already `satisfies`
// `Record<ExtensionRegistryCommandId, ...>` at compile time.
const catalogRegistryIds = (commandCatalog as readonly CommandCatalogEntry[])
  .filter((entry) => entry.extensionRegistry === true)
  .map((entry) => entry.id);

function asyncNoop() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeActions(): ExtensionCommandActions {
  return {
    showSettings: asyncNoop(),
    resetMainView: asyncNoop(),
    cleanBuild: asyncNoop(),
    pack: asyncNoop(),
    clean: asyncNoop(),
    compare: asyncNoop(),
    acceptEdited: vi.fn().mockResolvedValue(true),
    indentTeX: asyncNoop(),
    signIn: vi.fn().mockResolvedValue(false),
    signInChatGpt: vi.fn().mockResolvedValue(false),
    signInGrok: vi.fn().mockResolvedValue(false),
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
    showImportOptions: asyncNoop(),
    toggleView: asyncNoop(),
    showProgressView: asyncNoop(),
    setApiKey: asyncNoop(),
    createAgentWithAI: asyncNoop(),
    execute: asyncNoop(),
  };
}

function dispatch(
  actions: ExtensionCommandActions,
  id: keyof typeof EXTENSION_COMMAND_HANDLERS,
  ...args: unknown[]
): Promise<boolean> {
  return Promise.resolve(
    dispatchCommandFromRegistry(
      id,
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      ...args,
    ),
  );
}

describe('extension command surface — catalog-tagged command dispatch', () => {
  it('texra.auth.viewProfile opens the account tab', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.auth.viewProfile')).resolves.toBe(
      true,
    );
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith('account');
  });

  it('texra.showMemory passes the memory panel name', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.showMemory')).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith('memory');
  });

  it('texra.showAgents forwards parsed agent-category sub-tab', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.showAgents', 'toolUse'),
    ).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      'agents',
      'toolUse',
    );
  });

  it('texra.showAgents with no arg opens the agents tab without a sub-tab', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.showAgents')).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      'agents',
      undefined,
    );
  });

  it('texra.openDoc forwards parsed page argument', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.openDoc', 'getting-started'),
    ).resolves.toBe(true);
    expect(actions.openDoc).toHaveBeenCalledExactlyOnceWith('getting-started');
  });

  it('texra.openDoc rejects non-string raw arg', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.openDoc', 42)).resolves.toBe(false);
    expect(actions.openDoc).not.toHaveBeenCalled();
  });

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

      await expect(dispatch(actions, 'texra.pack', config)).resolves.toBe(true);
      await expect(dispatch(actions, 'texra.clean', config)).resolves.toBe(
        true,
      );
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
      ).resolves.toBe(true);
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

    it('forwards accept arguments when copy metadata is omitted', async () => {
      const actions = makeActions();

      await expect(
        dispatch(actions, 'texra.acceptEdited', BASE_FILE, EDITED_FILE),
      ).resolves.toBe(true);
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        BASE_FILE,
        EDITED_FILE,
        undefined,
      );
    });
  });

  it('texra.showProgressView with no arg defaults to inPlace=false', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.showProgressView')).resolves.toBe(
      true,
    );
    expect(actions.showProgressView).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('texra.showProgressView forwards inPlace=true', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.showProgressView', { inPlace: true }),
    ).resolves.toBe(true);
    expect(actions.showProgressView).toHaveBeenCalledExactlyOnceWith(true);
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

  it('texra.setApiKey forwards parsed provider', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.setApiKey', 'anthropic'),
    ).resolves.toBe(true);
    expect(actions.setApiKey).toHaveBeenCalledExactlyOnceWith('anthropic');
  });

  it('texra.setApiKey passes undefined when no provider given', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.setApiKey')).resolves.toBe(true);
    expect(actions.setApiKey).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('texra.setApiKey rejects unknown provider', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.setApiKey', 'not-a-provider'),
    ).resolves.toBe(false);
    expect(actions.setApiKey).not.toHaveBeenCalled();
  });

  it('texra.createAgentWithAI defaults to workflow when no category given', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.createAgentWithAI')).resolves.toBe(
      true,
    );
    expect(actions.createAgentWithAI).toHaveBeenCalledExactlyOnceWith(
      'workflow',
    );
  });

  it('texra.createAgentWithAI forwards parsed toolUse category', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.createAgentWithAI', 'toolUse'),
    ).resolves.toBe(true);
    expect(actions.createAgentWithAI).toHaveBeenCalledExactlyOnceWith(
      'toolUse',
    );
  });

  it('texra.execute forwards raw input through z.unknown() schema', async () => {
    const actions = makeActions();
    const payload = { config: { name: 'test' } };
    await expect(dispatch(actions, 'texra.execute', payload)).resolves.toBe(
      true,
    );
    expect(actions.execute).toHaveBeenCalledExactlyOnceWith(payload);
  });

  // Regression guard for #3782: handlers must propagate async rejections
  // instead of swallowing them through `void actions.X(); return true;`.
  // Each asserted handler returns a rejecting promise, and the dispatcher
  // must surface that same rejection to VS Code's `executeCommand` callers.
  describe('async rejection propagation (regression guard for #3782)', () => {
    it.each([
      ['texra.auth.signIn', 'signIn'],
      ['texra.showMemory', 'showSettings'],
      ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    ] as const)('%s rejection bubbles up', async (id, actionKey) => {
      const actions = makeActions();
      const failure = new Error(`boom-${actionKey}`);

      (actions[actionKey] as any).mockRejectedValueOnce(failure);

      await expect(dispatch(actions, id)).rejects.toBe(failure);
    });

    it('typed handler texra.openDoc rejection bubbles up', async () => {
      const actions = makeActions();
      const failure = new Error('boom-openDoc');

      (actions.openDoc as any).mockRejectedValueOnce(failure);

      await expect(
        dispatch(actions, 'texra.openDoc', 'getting-started'),
      ).rejects.toBe(failure);
    });
  });
});
