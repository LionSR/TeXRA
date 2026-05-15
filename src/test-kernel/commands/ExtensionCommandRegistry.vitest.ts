// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports
import type { ExtensionCommandActions } from '@commands/extensionCommandSurface';
import {
  definedHandler,
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import { AgentCategorySchema } from '@shared/schemas/agent';
import { StreamTabIdSchema } from '@shared/schemas/identifiers';

// Re-implement the extension's no-arg handler map here in test form. We
// can't import the real `extensionCommandSurface.ts` from a vitest run
// because it transitively pulls in `vscode`. The point of this test is
// not to re-test the dispatcher (covered in CommandRegistry.vitest.ts);
// it's to lock in that each newly migrated id (#3771, #3775, #3781)
// calls the right `actions.*` method, AND that async failures
// propagate through the dispatcher (regression guard for #3782).
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

function awaitTrue(p: Promise<unknown> | Thenable<unknown>): Promise<boolean> {
  return Promise.resolve(p).then(() => true);
}

const HANDLERS = {
  'texra.cleanOutput': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.cleanOutput()),
  'texra.cleanBuild': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.cleanBuild()),
  'texra.indentTeX': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.indentTeX()),
  'texra.auth.signIn': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.signIn()),
  'texra.auth.signOut': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.signOut()),
  'texra.auth.viewProfile': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.viewProfile()),
  'texra.showMemory': (actions: ExtensionCommandActions) => {
    actions.showSettings(SETTINGS_TAB.MEMORY);
    return true;
  },
  'texra.runSetupAssistant': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.runSetupAssistant()),
  'texra.openGettingStarted': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.openGettingStarted()),
  'texra.createSampleProject': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.createSampleProject()),
  'texra.downloadArXivSource': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.downloadArXivSource()),
  'texra.testConnection': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.testConnection()),
  'texra.testAgentLoading': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.testAgentLoading()),
  'texra.loadSpecificAgent': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.loadSpecificAgent()),
  'texra.openProgressViewInTab': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.openProgressViewInTab()),
  'texra.openDoc': definedHandler(
    z.string(),
    (actions: ExtensionCommandActions, page) =>
      awaitTrue(actions.openDoc(page)),
  ),
  'texra.stopAgent': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) => {
      actions.stopAgent(streamId);
      return true;
    },
  ),
  'texra.compactResponse': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) =>
      awaitTrue(actions.compactResponse(streamId)),
  ),
  // Batch 2 (#3775) — no-arg host-context commands.
  'texra.parseXml': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.parseXml()),
  'texra.parseYaml': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.parseYaml()),
  'texra.testTextEditor': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.testTextEditor()),
  'texra.indentCurrentTeX': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.indentCurrentTeX()),
  'texra.applyReplacements': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.applyReplacements()),
  'texra.fixCompilation': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.fixCompilation()),
  'texra.getTeXCount': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.getTeXCount()),
  'texra.countPdfPages': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.countPdfPages()),
  'texra.showLinterMessages': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.showLinterMessages()),
  'texra.countLinterMessages': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.countLinterMessages()),
  'texra.extractFigurePaths': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.extractFigurePaths()),
  // Batch 3 (#3781) — additional no-arg commands; same async pattern.
  'texra.encodeImageToBase64': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.encodeImageToBase64()),
  'texra.convertPdfToImages': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.convertPdfToImages()),
  'texra.extractTikzFigures': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.extractTikzFigures()),
  'texra.compileTikzFigures': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.compileTikzFigures()),
  'texra.cloneOverleafProject': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.cloneOverleafProject()),
  // Batch 4 (#3781) — settings/api/agent surface follow-ups. Mirrors the
  // real `EXTENSION_COMMAND_HANDLERS` shape so each migrated id is
  // exercised through the dispatcher without importing the host-coupled
  // surface. The `ApiProvider` schema is duplicated locally because
  // `SecretManager` carries a `vscode` import.
  'texra.removeApiKey': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.removeApiKey()),
  'texra.showImportOptions': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.showImportOptions()),
  'texra.toggleView': (actions: ExtensionCommandActions) =>
    awaitTrue(actions.toggleView()),
  'texra.showProgressView': definedHandler(
    z.object({ inPlace: z.boolean().optional() }).partial().optional(),
    (actions: ExtensionCommandActions, parsed) =>
      awaitTrue(actions.showProgressView(parsed?.inPlace === true)),
  ),
  'texra.setApiKey': definedHandler(
    z
      .enum([
        'openai',
        'anthropic',
        'openRouter',
        'google',
        'xai',
        'deepseek',
        'moonshot',
        'dashscope',
        'minimax',
        'glm',
      ])
      .optional(),
    (actions: ExtensionCommandActions, provider) =>
      awaitTrue(actions.setApiKey(provider)),
  ),
  'texra.createAgentWithAI': definedHandler(
    AgentCategorySchema.optional(),
    (actions: ExtensionCommandActions, category) =>
      awaitTrue(actions.createAgentWithAI(category ?? 'workflow')),
  ),
  'texra.execute': definedHandler(
    z.unknown(),
    (actions: ExtensionCommandActions, input) =>
      awaitTrue(actions.execute(input)),
  ),
  // The typed handlers carry their own argument shapes via
  // `definedHandler`. Matching the registry map's per-entry TArgs widening
  // (`any`) keeps inference per entry without unifying every entry on
  // `unknown`.
} satisfies Record<string, CommandHandler<ExtensionCommandActions, any>>;

function makeActions(): ExtensionCommandActions {
  return {
    showSettings: vi.fn(),
    resetMainView: vi.fn().mockResolvedValue(undefined),
    openWorkbenchSettings: vi.fn().mockReturnValue(Promise.resolve()),
    cleanBuild: vi.fn().mockResolvedValue(undefined),
    cleanOutput: vi.fn().mockResolvedValue(undefined),
    indentTeX: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(false),
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
    // Batch 4 (#3781).
    removeApiKey: vi.fn().mockResolvedValue(undefined),
    showImportOptions: vi.fn().mockResolvedValue(undefined),
    toggleView: vi.fn().mockResolvedValue(undefined),
    showProgressView: vi.fn().mockResolvedValue(undefined),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    createAgentWithAI: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

describe('extension command surface — newly migrated commands (#3771, #3775, #3781)', () => {
  it.each([
    ['texra.cleanOutput', 'cleanOutput'],
    ['texra.cleanBuild', 'cleanBuild'],
    ['texra.indentTeX', 'indentTeX'],
    ['texra.auth.signIn', 'signIn'],
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
    const result = dispatchCommandFromRegistry(id, HANDLERS, actions);
    // Async handlers return a promise; awaiting must resolve to `true`.
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions[actionKey]).toHaveBeenCalledOnce();
  });

  it('texra.showMemory passes the memory tab index', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry('texra.showMemory', HANDLERS, actions),
    ).toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.MEMORY,
    );
  });

  it('texra.openDoc forwards parsed page argument', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.openDoc',
      HANDLERS,
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
        HANDLERS,
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
        HANDLERS,
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
      HANDLERS,
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
        HANDLERS,
        actions,
        undefined,
        '',
      ),
    ).toBe(false);
    expect(actions.compactResponse).not.toHaveBeenCalled();
  });

  // Batch 4 (#3781) typed-arg coverage.
  it('texra.showProgressView with no arg defaults to inPlace=false', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showProgressView',
      HANDLERS,
      actions,
    );
    await expect(Promise.resolve(result)).resolves.toBe(true);
    expect(actions.showProgressView).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('texra.showProgressView forwards inPlace=true', async () => {
    const actions = makeActions();
    const result = dispatchCommandFromRegistry(
      'texra.showProgressView',
      HANDLERS,
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
      HANDLERS,
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
      HANDLERS,
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
        HANDLERS,
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
      HANDLERS,
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
      HANDLERS,
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
      HANDLERS,
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
      ['texra.encodeImageToBase64', 'encodeImageToBase64'],
      ['texra.cloneOverleafProject', 'cloneOverleafProject'],
    ] as const)('%s rejection bubbles up', async (id, actionKey) => {
      const actions = makeActions();
      const failure = new Error(`boom-${actionKey}`);

      (actions[actionKey] as any).mockRejectedValueOnce(failure);

      const result = dispatchCommandFromRegistry(id, HANDLERS, actions);
      await expect(Promise.resolve(result)).rejects.toBe(failure);
    });

    it('typed handler texra.compactResponse rejection bubbles up', async () => {
      const actions = makeActions();
      const failure = new Error('boom-compactResponse');

      (actions.compactResponse as any).mockRejectedValueOnce(failure);

      const result = dispatchCommandFromRegistry(
        'texra.compactResponse',
        HANDLERS,
        actions,
        undefined,
        'stream-3',
      );
      await expect(Promise.resolve(result)).rejects.toBe(failure);
    });
  });
});
