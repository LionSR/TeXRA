// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  EXTENSION_COMMAND_HANDLERS,
  EXTENSION_INTERNAL_COMMAND_IDS,
  EXTENSION_REGISTRY_CATALOG_COMMAND_IDS,
  type ExtensionCommandActions,
  type ExtensionRegistryCommandId,
} from '@commands/extensionCommandHandlers';
import {
  commandCatalog,
  type CommandCatalogEntry,
} from '@shared/commands/catalog';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// `extensionCommandHandlers.ts` is deliberately free of `vscode` imports, so
// the production handler map is exercised directly here. Only
// `extensionCommandSurface.ts`, which wires the real actions against VS Code
// APIs, needs the extension host.

function asyncNoop() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeActions(): ExtensionCommandActions {
  return {
    showSettings: asyncNoop(),
    resetMainView: asyncNoop(),
    cleanBuild: asyncNoop(),
    cleanOutput: asyncNoop(),
    pack: asyncNoop(),
    packSingle: asyncNoop(),
    packMultiple: asyncNoop(),
    clean: asyncNoop(),
    cleanSingle: asyncNoop(),
    cleanMultiple: asyncNoop(),
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
    stopAgent: vi.fn(),
    compactResponse: asyncNoop(),
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
  id: ExtensionRegistryCommandId,
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

describe('extension command registry — catalog-driven registration', () => {
  it('registers exactly the catalog ids tagged extensionRegistry, plus hidden aliases', () => {
    const registered = Object.keys(EXTENSION_COMMAND_HANDLERS).sort();
    const expected = [
      ...EXTENSION_REGISTRY_CATALOG_COMMAND_IDS,
      ...EXTENSION_INTERNAL_COMMAND_IDS,
    ].sort();
    expect(registered).toEqual(expected);
  });

  it('flags a catalog entry tagged extensionRegistry that has no handler', () => {
    // Guards the assertion above against a false-positive pass: if a
    // future catalog entry is tagged `extensionRegistry: true` without a
    // matching handler, the id set comparison must fail rather than
    // silently pass.
    const taggedIds = new Set(
      (commandCatalog as readonly CommandCatalogEntry[])
        .filter((entry) => entry.extensionRegistry === true)
        .map((entry) => entry.id),
    );
    const registeredIds = new Set(Object.keys(EXTENSION_COMMAND_HANDLERS));
    for (const id of taggedIds) {
      expect(registeredIds.has(id)).toBe(true);
    }
  });

  it.each(EXTENSION_INTERNAL_COMMAND_IDS)(
    'internal command %s is absent from the public catalog',
    (id) => {
      expect(commandCatalog.some((entry) => (entry.id as string) === id)).toBe(
        false,
      );
    },
  );
});

describe('extension command surface — catalog-tagged command dispatch', () => {
  it.each([
    ['texra.showDashboard', 'showSettings'],
    ['texra.showSettingsView', 'showSettings'],
    ['texra.cleanOutput', 'cleanOutput'],
    ['texra.cleanBuild', 'cleanBuild'],
    ['texra.indentTeX', 'indentTeX'],
    ['texra.auth.signIn', 'signIn'],
    ['texra.auth.chatgpt.signIn', 'signInChatGpt'],
    ['texra.auth.grok.signIn', 'signInGrok'],
    ['texra.auth.signOut', 'signOut'],
    ['texra.runSetupAssistant', 'runSetupAssistant'],
    ['texra.openGettingStarted', 'openGettingStarted'],
    ['texra.createSampleProject', 'createSampleProject'],
    ['texra.downloadArXivSource', 'downloadArXivSource'],
    ['texra.openProgressViewInTab', 'openProgressViewInTab'],
    ['texra.indentCurrentTeX', 'indentCurrentTeX'],
    ['texra.fixCompilation', 'fixCompilation'],
    ['texra.getTeXCount', 'getTeXCount'],
    ['texra.extractTikzFigures', 'extractTikzFigures'],
    ['texra.compileTikzFigures', 'compileTikzFigures'],
    ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    ['texra.removeApiKey', 'removeApiKey'],
    ['texra.showImportOptions', 'showImportOptions'],
    ['texra.toggleView', 'toggleView'],
  ] as const)('%s dispatches to actions.%s', async (id, actionKey) => {
    const actions = makeActions();
    await expect(dispatch(actions, id)).resolves.toBe(true);
    expect(actions[actionKey]).toHaveBeenCalledOnce();
  });

  it('texra.auth.viewProfile opens the account tab', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.auth.viewProfile')).resolves.toBe(
      true,
    );
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.ACCOUNT,
    );
  });

  it('texra.showMemory passes the memory tab index', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.showMemory')).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.MEMORY,
    );
  });

  it('texra.showAgents forwards parsed agent-category sub-tab', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.showAgents', 'toolUse'),
    ).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.AGENTS,
      'toolUse',
    );
  });

  it('texra.showAgents with no arg opens the agents tab without a sub-tab', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.showAgents')).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.AGENTS,
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

  it('texra.stopAgent forwards parsed streamId', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.stopAgent', 'stream-1'),
    ).resolves.toBe(true);
    expect(actions.stopAgent).toHaveBeenCalledExactlyOnceWith('stream-1');
  });

  it('texra.compactResponse forwards parsed streamId', async () => {
    const actions = makeActions();
    await expect(
      dispatch(actions, 'texra.compactResponse', 'stream-2'),
    ).resolves.toBe(true);
    expect(actions.compactResponse).toHaveBeenCalledExactlyOnceWith('stream-2');
  });

  it('texra.compactResponse rejects empty streamId', async () => {
    const actions = makeActions();
    await expect(dispatch(actions, 'texra.compactResponse', '')).resolves.toBe(
      false,
    );
    expect(actions.compactResponse).not.toHaveBeenCalled();
  });

  describe('typed file-operation arguments', () => {
    const WORKSPACE_INPUT = {
      kind: 'workspace' as const,
      absolutePath: '/workspace/main.tex',
      relativePath: 'main.tex',
    };
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

    it('forwards positional single-file pack/clean arguments', async () => {
      const actions = makeActions();

      await expect(
        dispatch(actions, 'texra.packSingle', 'main.tex', 'editor', 'gpt-5'),
      ).resolves.toBe(true);
      await expect(
        dispatch(actions, 'texra.cleanSingle', 'main.tex', 'editor', 'gpt-5'),
      ).resolves.toBe(true);
      expect(actions.packSingle).toHaveBeenCalledExactlyOnceWith(
        'main.tex',
        'editor',
        'gpt-5',
      );
      expect(actions.cleanSingle).toHaveBeenCalledExactlyOnceWith(
        'main.tex',
        'editor',
        'gpt-5',
      );
    });

    it('defaults omitted multi-file lists before dispatch', async () => {
      const actions = makeActions();

      await expect(
        dispatch(actions, 'texra.packMultiple', 'main.tex', 'editor', 'gpt-5'),
      ).resolves.toBe(true);
      await expect(
        dispatch(actions, 'texra.cleanMultiple', 'main.tex', 'editor', 'gpt-5'),
      ).resolves.toBe(true);
      expect(actions.packMultiple).toHaveBeenCalledExactlyOnceWith(
        'main.tex',
        'editor',
        'gpt-5',
        [],
      );
      expect(actions.cleanMultiple).toHaveBeenCalledExactlyOnceWith(
        'main.tex',
        'editor',
        'gpt-5',
        [],
      );
    });

    it('accepts packMultiple with only a nonempty inputFiles list', async () => {
      const actions = makeActions();

      await expect(
        dispatch(actions, 'texra.packMultiple', '', 'editor', 'gpt-5', [
          'chapter.tex',
        ]),
      ).resolves.toBe(true);
      expect(actions.packMultiple).toHaveBeenCalledExactlyOnceWith(
        '',
        'editor',
        'gpt-5',
        ['chapter.tex'],
      );
    });

    it('forwards compare and accept arguments without collapsing them', async () => {
      const actions = makeActions();

      await expect(
        dispatch(
          actions,
          'texra.compare',
          WORKSPACE_INPUT,
          BASE_FILE,
          EDITED_FILE,
        ),
      ).resolves.toBe(true);
      await expect(
        dispatch(
          actions,
          'texra.acceptEdited',
          WORKSPACE_INPUT,
          BASE_FILE,
          EDITED_FILE,
          COPY_META,
        ),
      ).resolves.toBe(true);
      expect(actions.compare).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE_INPUT,
        BASE_FILE,
        EDITED_FILE,
      );
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE_INPUT,
        BASE_FILE,
        EDITED_FILE,
        COPY_META,
      );
    });

    it('forwards accept arguments when copy metadata is omitted', async () => {
      const actions = makeActions();

      await expect(
        dispatch(
          actions,
          'texra.acceptEdited',
          WORKSPACE_INPUT,
          BASE_FILE,
          EDITED_FILE,
        ),
      ).resolves.toBe(true);
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE_INPUT,
        BASE_FILE,
        EDITED_FILE,
        undefined,
      );
    });

    it('preserves the input-location fallback when base is omitted', async () => {
      const actions = makeActions();

      await expect(
        dispatch(
          actions,
          'texra.compare',
          WORKSPACE_INPUT,
          undefined,
          EDITED_FILE,
        ),
      ).resolves.toBe(true);
      await expect(
        dispatch(
          actions,
          'texra.acceptEdited',
          WORKSPACE_INPUT,
          undefined,
          EDITED_FILE,
        ),
      ).resolves.toBe(true);
      expect(actions.compare).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE_INPUT,
        undefined,
        EDITED_FILE,
      );
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE_INPUT,
        undefined,
        EDITED_FILE,
        undefined,
      );
    });

    it('rejects malformed positional arguments before calling actions', async () => {
      const actions = makeActions();

      await expect(
        dispatch(actions, 'texra.packSingle', '', 'editor', 'gpt-5'),
      ).resolves.toBe(false);
      expect(actions.packSingle).not.toHaveBeenCalled();
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
      ['texra.cleanOutput', 'cleanOutput'],
      ['texra.auth.signIn', 'signIn'],
      ['texra.showMemory', 'showSettings'],
      ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    ] as const)('%s rejection bubbles up', async (id, actionKey) => {
      const actions = makeActions();
      const failure = new Error(`boom-${actionKey}`);

      (actions[actionKey] as any).mockRejectedValueOnce(failure);

      await expect(dispatch(actions, id)).rejects.toBe(failure);
    });

    it('typed handler texra.compactResponse rejection bubbles up', async () => {
      const actions = makeActions();
      const failure = new Error('boom-compactResponse');

      (actions.compactResponse as any).mockRejectedValueOnce(failure);

      await expect(
        dispatch(actions, 'texra.compactResponse', 'stream-3'),
      ).rejects.toBe(failure);
    });
  });
});
