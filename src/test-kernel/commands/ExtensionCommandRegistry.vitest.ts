// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  EXTENSION_COMMAND_HANDLERS,
  EXTENSION_INTERNAL_COMMAND_IDS,
  EXTENSION_REGISTRY_CATALOG_COMMAND_IDS,
  type ExtensionCommandActions,
} from '@commands/extensionCommandHandlers';
import {
  commandCatalog,
  type CommandCatalogEntry,
} from '@shared/commands/catalog';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// `extensionCommandHandlers.ts` is deliberately free of `vscode` imports,
// so — unlike `extensionCommandSurface.ts`, which wires the real actions
// against VS Code APIs — the real handler map can be exercised here
// directly. There is no hand-copied re-implementation to drift out of
// sync with the production map.

function makeActions(): ExtensionCommandActions {
  return {
    showSettings: vi.fn().mockResolvedValue(undefined),
    resetMainView: vi.fn().mockResolvedValue(undefined),
    openWorkbenchSettings: vi.fn().mockReturnValue(Promise.resolve()),
    cleanBuild: vi.fn().mockResolvedValue(undefined),
    cleanOutput: vi.fn().mockResolvedValue(undefined),
    pack: vi.fn().mockResolvedValue(undefined),
    packSingle: vi.fn().mockResolvedValue(undefined),
    packMultiple: vi.fn().mockResolvedValue(undefined),
    clean: vi.fn().mockResolvedValue(undefined),
    cleanSingle: vi.fn().mockResolvedValue(undefined),
    cleanMultiple: vi.fn().mockResolvedValue(undefined),
    compare: vi.fn().mockResolvedValue(undefined),
    acceptEdited: vi.fn().mockResolvedValue(true),
    indentTeX: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(false),
    signInChatGpt: vi.fn().mockResolvedValue(false),
    signOut: vi.fn().mockResolvedValue(undefined),
    viewProfile: vi.fn().mockResolvedValue(undefined),
    runSetupAssistant: vi.fn().mockResolvedValue(undefined),
    openGettingStarted: vi.fn().mockReturnValue(Promise.resolve()),
    createSampleProject: vi.fn().mockResolvedValue(undefined),
    downloadArXivSource: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue(undefined),
    testAgentLoading: vi.fn().mockResolvedValue(undefined),
    loadSpecificAgent: vi.fn().mockResolvedValue(undefined),
    openProgressViewInTab: vi.fn().mockResolvedValue(undefined),
    openDoc: vi.fn().mockResolvedValue(undefined),
    stopAgent: vi.fn(),
    compactResponse: vi.fn().mockResolvedValue(undefined),
    parseXml: vi.fn().mockResolvedValue(undefined),
    parseYaml: vi.fn().mockResolvedValue(undefined),
    testTextEditor: vi.fn().mockResolvedValue(undefined),
    indentCurrentTeX: vi.fn().mockResolvedValue(undefined),
    applyReplacements: vi.fn().mockResolvedValue(undefined),
    fixCompilation: vi.fn().mockResolvedValue(undefined),
    getTeXCount: vi.fn().mockResolvedValue(undefined),
    countPdfPages: vi.fn().mockResolvedValue(undefined),
    showLinterMessages: vi.fn().mockResolvedValue(undefined),
    countLinterMessages: vi.fn().mockResolvedValue(undefined),
    extractFigurePaths: vi.fn().mockResolvedValue(undefined),
    encodeImageToBase64: vi.fn().mockResolvedValue(undefined),
    convertPdfToImages: vi.fn().mockResolvedValue(undefined),
    extractTikzFigures: vi.fn().mockResolvedValue(undefined),
    compileTikzFigures: vi.fn().mockResolvedValue(undefined),
    cloneOverleafProject: vi.fn().mockResolvedValue(undefined),
    removeApiKey: vi.fn().mockResolvedValue(undefined),
    showImportOptions: vi.fn().mockResolvedValue(undefined),
    toggleView: vi.fn().mockResolvedValue(undefined),
    showProgressView: vi.fn().mockResolvedValue(undefined),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    createAgentWithAI: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
  };
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

describe('extension command surface — newly migrated commands (#3771, #3775, #3781)', () => {
  it.each([
    ['texra.showDashboard', 'showSettings'],
    ['texra.showSettingsView', 'showSettings'],
    ['texra.cleanOutput', 'cleanOutput'],
    ['texra.cleanBuild', 'cleanBuild'],
    ['texra.indentTeX', 'indentTeX'],
    ['texra.auth.signIn', 'signIn'],
    ['texra.auth.chatgpt.signIn', 'signInChatGpt'],
    ['texra.auth.signOut', 'signOut'],
    ['texra.auth.viewProfile', 'viewProfile'],
    ['texra.runSetupAssistant', 'runSetupAssistant'],
    ['texra.openGettingStarted', 'openGettingStarted'],
    ['texra.createSampleProject', 'createSampleProject'],
    ['texra.downloadArXivSource', 'downloadArXivSource'],
    ['texra.testConnection', 'testConnection'],
    ['texra.testAgentLoading', 'testAgentLoading'],
    ['texra.loadSpecificAgent', 'loadSpecificAgent'],
    ['texra.openProgressViewInTab', 'openProgressViewInTab'],
    // Batch 2 (#3775)
    ['texra.parseXml', 'parseXml'],
    ['texra.parseYaml', 'parseYaml'],
    ['texra.testTextEditor', 'testTextEditor'],
    ['texra.indentCurrentTeX', 'indentCurrentTeX'],
    ['texra.applyReplacements', 'applyReplacements'],
    ['texra.fixCompilation', 'fixCompilation'],
    ['texra.getTeXCount', 'getTeXCount'],
    ['texra.countPdfPages', 'countPdfPages'],
    ['texra.showLinterMessages', 'showLinterMessages'],
    ['texra.countLinterMessages', 'countLinterMessages'],
    ['texra.extractFigurePaths', 'extractFigurePaths'],
    // Batch 3 (#3781)
    ['texra.encodeImageToBase64', 'encodeImageToBase64'],
    ['texra.convertPdfToImages', 'convertPdfToImages'],
    ['texra.extractTikzFigures', 'extractTikzFigures'],
    ['texra.compileTikzFigures', 'compileTikzFigures'],
    ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    // Batch 4 (#3781)
    ['texra.removeApiKey', 'removeApiKey'],
    ['texra.showImportOptions', 'showImportOptions'],
    ['texra.toggleView', 'toggleView'],
  ] as const)('%s dispatches to actions.%s', async (id, actionKey) => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      id,
      EXTENSION_COMMAND_HANDLERS,
      actions,
    );
    // Async handlers return a promise; awaiting must resolve to `true`.
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions[actionKey]).toHaveBeenCalledOnce();
  });

  it('texra.showMemory passes the memory tab index', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showMemory',
      EXTENSION_COMMAND_HANDLERS,
      actions,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.MEMORY,
    );
  });

  it('texra.showAgents forwards parsed agent-category sub-tab', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showAgents',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      'toolUse',
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.AGENTS,
      'toolUse',
    );
  });

  it('texra.showAgents with no arg opens the agents tab without a sub-tab', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showAgents',
      EXTENSION_COMMAND_HANDLERS,
      actions,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.AGENTS,
      undefined,
    );
  });

  it('texra.openDoc forwards parsed page argument', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.openDoc',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      'getting-started',
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.openDoc).toHaveBeenCalledExactlyOnceWith('getting-started');
  });

  it('texra.openDoc rejects non-string raw arg', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.openDoc',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        42,
      ),
    ).toBe(false);
    expect(actions.openDoc).not.toHaveBeenCalled();
  });

  it('texra.stopAgent forwards parsed streamId', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.stopAgent',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'stream-1',
      ),
    ).toBe(true);
    expect(actions.stopAgent).toHaveBeenCalledExactlyOnceWith('stream-1');
  });

  it('texra.compactResponse forwards parsed streamId', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.compactResponse',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      'stream-2',
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.compactResponse).toHaveBeenCalledExactlyOnceWith('stream-2');
  });

  it('texra.compactResponse rejects empty streamId', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.compactResponse',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        '',
      ),
    ).toBe(false);
    expect(actions.compactResponse).not.toHaveBeenCalled();
  });

  describe('typed file-operation arguments (#9090)', () => {
    it('normalizes and forwards pack/clean config objects', async () => {
      const actions = makeActions();
      const config = {
        inputFile: 'main.tex',
        agent: 'editor',
        model: 'gpt-5',
      };

      const packResult = dispatchCommandFromRegistry(
        'texra.pack',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        config,
      );
      const cleanResult = dispatchCommandFromRegistry(
        'texra.clean',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        config,
      );

      await expect(Promise.resolve(packResult)).resolves.toBe(true);
      await expect(Promise.resolve(cleanResult)).resolves.toBe(true);
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

      const packResult = dispatchCommandFromRegistry(
        'texra.packSingle',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'main.tex',
        'editor',
        'gpt-5',
      );
      const cleanResult = dispatchCommandFromRegistry(
        'texra.cleanSingle',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'main.tex',
        'editor',
        'gpt-5',
      );

      await expect(Promise.resolve(packResult)).resolves.toBe(true);
      await expect(Promise.resolve(cleanResult)).resolves.toBe(true);
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

      const packResult = dispatchCommandFromRegistry(
        'texra.packMultiple',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'main.tex',
        'editor',
        'gpt-5',
      );
      const cleanResult = dispatchCommandFromRegistry(
        'texra.cleanMultiple',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'main.tex',
        'editor',
        'gpt-5',
      );

      await expect(Promise.resolve(packResult)).resolves.toBe(true);
      await expect(Promise.resolve(cleanResult)).resolves.toBe(true);
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

      const result = dispatchCommandFromRegistry(
        'texra.packMultiple',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        '',
        'editor',
        'gpt-5',
        ['chapter.tex'],
      );

      await expect(Promise.resolve(result)).resolves.toBe(true);
      expect(actions.packMultiple).toHaveBeenCalledExactlyOnceWith(
        '',
        'editor',
        'gpt-5',
        ['chapter.tex'],
      );
    });

    it('forwards compare and accept arguments without collapsing them', async () => {
      const actions = makeActions();
      const input = {
        kind: 'workspace' as const,
        absolutePath: '/workspace/main.tex',
        relativePath: 'main.tex',
      };
      const base = {
        kind: 'external' as const,
        absolutePath: '/tmp/base.tex',
      };
      const edited = {
        kind: 'external' as const,
        absolutePath: '/tmp/edited.tex',
      };
      const copyMeta = { agent: 'editor', model: 'gpt-5', round: 2 };

      const compareResult = dispatchCommandFromRegistry(
        'texra.compare',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        input,
        base,
        edited,
      );
      const acceptResult = dispatchCommandFromRegistry(
        'texra.acceptEdited',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        input,
        base,
        edited,
        copyMeta,
      );

      await expect(Promise.resolve(compareResult)).resolves.toBe(true);
      await expect(Promise.resolve(acceptResult)).resolves.toBe(true);
      expect(actions.compare).toHaveBeenCalledExactlyOnceWith(
        input,
        base,
        edited,
      );
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        input,
        base,
        edited,
        copyMeta,
      );
    });

    it('forwards accept arguments when copy metadata is omitted', async () => {
      const actions = makeActions();
      const input = {
        kind: 'workspace' as const,
        absolutePath: '/workspace/main.tex',
        relativePath: 'main.tex',
      };
      const base = {
        kind: 'external' as const,
        absolutePath: '/tmp/base.tex',
      };
      const edited = {
        kind: 'external' as const,
        absolutePath: '/tmp/edited.tex',
      };

      const result = dispatchCommandFromRegistry(
        'texra.acceptEdited',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        input,
        base,
        edited,
      );

      await expect(Promise.resolve(result)).resolves.toBe(true);
      expect(actions.acceptEdited).toHaveBeenCalledExactlyOnceWith(
        input,
        base,
        edited,
        undefined,
      );
    });

    it('rejects malformed positional arguments before calling actions', () => {
      const actions = makeActions();

      expect(
        dispatchCommandFromRegistry(
          'texra.packSingle',
          EXTENSION_COMMAND_HANDLERS,
          actions,
          undefined,
          '',
          'editor',
          'gpt-5',
        ),
      ).toBe(false);
      expect(actions.packSingle).not.toHaveBeenCalled();
    });
  });

  // Batch 4 (#3781) typed-arg coverage.
  it('texra.showProgressView with no arg defaults to inPlace=false', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showProgressView',
      EXTENSION_COMMAND_HANDLERS,
      actions,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.showProgressView).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('texra.showProgressView forwards inPlace=true', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showProgressView',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      { inPlace: true },
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.showProgressView).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('texra.setApiKey forwards parsed provider', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.setApiKey',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      'anthropic',
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.setApiKey).toHaveBeenCalledExactlyOnceWith('anthropic');
  });

  it('texra.setApiKey passes undefined when no provider given', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.setApiKey',
      EXTENSION_COMMAND_HANDLERS,
      actions,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.setApiKey).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('texra.setApiKey rejects unknown provider', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.setApiKey',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'not-a-provider',
      ),
    ).toBe(false);
    expect(actions.setApiKey).not.toHaveBeenCalled();
  });

  it('texra.createAgentWithAI defaults to workflow when no category given', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.createAgentWithAI',
      EXTENSION_COMMAND_HANDLERS,
      actions,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.createAgentWithAI).toHaveBeenCalledExactlyOnceWith(
      'workflow',
    );
  });

  it('texra.createAgentWithAI forwards parsed toolUse category', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.createAgentWithAI',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      'toolUse',
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.createAgentWithAI).toHaveBeenCalledExactlyOnceWith(
      'toolUse',
    );
  });

  it('texra.execute forwards raw input through z.unknown() schema', async () => {
    const actions = makeActions();
    const payload = { config: { name: 'test' } };
    const result = dispatchCommandFromRegistry(
      'texra.execute',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
      payload,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.execute).toHaveBeenCalledExactlyOnceWith(payload);
  });

  // Regression guard for #3782: the migrated handlers must propagate
  // async rejections instead of swallowing them through `void
  // actions.X(); return true;`. Each asserted handler returns a
  // promise that rejects — the dispatcher should surface the same
  // rejection so VS Code's `executeCommand` callers (and the bot
  // reviewer that filed #3782) actually see the failure.
  describe('async rejection propagation (regression guard for #3782)', () => {
    it.each([
      ['texra.cleanOutput', 'cleanOutput'],
      ['texra.auth.signIn', 'signIn'],
      ['texra.showMemory', 'showSettings'],
      ['texra.encodeImageToBase64', 'encodeImageToBase64'],
      ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    ] as const)('%s rejection bubbles up', async (id, actionKey) => {
      const actions = makeActions();
      const failure = new Error(`boom-${actionKey}`);

      (actions[actionKey] as any).mockRejectedValueOnce(failure);

      const result = dispatchCommandFromRegistry(
        id,
        EXTENSION_COMMAND_HANDLERS,
        actions,
      );
      await expect(Promise.resolve(result)).rejects.toBe(failure);
    });

    it('typed handler texra.compactResponse rejection bubbles up', async () => {
      const actions = makeActions();
      const failure = new Error('boom-compactResponse');

      (actions.compactResponse as any).mockRejectedValueOnce(failure);

      const result = dispatchCommandFromRegistry(
        'texra.compactResponse',
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
        'stream-3',
      );
      await expect(Promise.resolve(result)).rejects.toBe(failure);
    });
  });
});
