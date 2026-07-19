// Third-party imports
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - history dependencies
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { ChatExportInput } from '@controllers/settingsView/ChatExportController';
import type { DesktopHistoryOptions } from '@desktop/main/desktopHistoryHandlers';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
import { assertSupported } from '@shared/utils/dispatcher';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files';

// Local imports - desktop test support

// Local imports - controller types
import { createStubDesktopHistoryOptions } from './desktopSettingsTestSupport';
import {
  desktopSourcePath,
  moduleFileUrl,
  repoPath,
} from './desktopTestPaths.mjs';

const chatExportMocks = vi.hoisted(() => ({
  buildExportInput: vi.fn(),
  exportAsMarkdown: vi.fn(),
  exportAsLatex: vi.fn(),
  exportAsHtml: vi.fn(),
  constructorDeps: [] as unknown[],
  constructorError: undefined as Error | undefined,
}));
const historyMocks = vi.hoisted(() => ({
  buildHistoryMessage: vi.fn(),
}));

vi.mock('@controllers/settingsView/ChatExportController', () => ({
  ChatExportController: class {
    buildExportInput = chatExportMocks.buildExportInput;
    exportAsMarkdown = chatExportMocks.exportAsMarkdown;
    exportAsLatex = chatExportMocks.exportAsLatex;
    exportAsHtml = chatExportMocks.exportAsHtml;

    constructor(dependencies: unknown) {
      chatExportMocks.constructorDeps.push(dependencies);
      const error = chatExportMocks.constructorError;
      chatExportMocks.constructorError = undefined;
      if (error) throw error;
    }
  },
}));

vi.mock('@controllers/settingsView/HistoryMessageBuilder', () => ({
  buildHistoryMessage: historyMocks.buildHistoryMessage,
}));

type DesktopHistoryHandlersModule =
  typeof import('@desktop/main/desktopHistoryHandlers');
type DesktopHistoryDependencies = ConstructorParameters<
  DesktopHistoryHandlersModule['DesktopHistoryHandlers']
>[0];
type DesktopHistoryCapabilities = Pick<
  DesktopHistoryOptions,
  'resourcesPath' | 'runExecution' | 'restoreTaskState'
>;
type DesktopHistoryActionOverrides = Partial<
  Omit<DesktopHistoryDependencies, keyof DesktopHistoryCapabilities>
> & {
  history?: Partial<DesktopHistoryCapabilities>;
};

const RESOURCES_PATH = repoPath('packages', 'extension', 'resources');
const HISTORY_ID = 'bbbb2222';
const HISTORY_CONFIG = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check a proof.',
  agentCategory: AgentCategory.ToolUse,
});
const EXPORT_INPUT: ChatExportInput = {
  timestamp: '2026-01-01T00:00:00.000Z',
  config: { agent: 'chat' },
  messages: [],
};

let DesktopHistoryHandlers!: DesktopHistoryHandlersModule['DesktopHistoryHandlers'];

setupPlatform();

function createHistoryController(
  overrides: DesktopHistoryActionOverrides = {},
) {
  const {
    history,
    postToRenderer = vi.fn(),
    onError = vi.fn(),
    ...optionalDependencies
  } = overrides;
  return new DesktopHistoryHandlers({
    ...createStubDesktopHistoryOptions({
      resourcesPath: RESOURCES_PATH,
      ...history,
    }),
    postToRenderer,
    onError,
    ...optionalDependencies,
  });
}

function createHistoryActions(overrides: DesktopHistoryActionOverrides = {}) {
  return createHistoryController(overrides).actions;
}

async function writeHistoryConfig(): Promise<void> {
  await getExecutionStore(HISTORY_ID).writeConfig(HISTORY_CONFIG);
}

async function writeForeignLease(executionId: string): Promise<void> {
  await StorageFS.ensureDir('executionLeases');
  await StorageFS.writeAtomic(
    `executionLeases/${executionId}.json`,
    JSON.stringify({
      version: 1,
      executionId,
      ownerToken: '00000000-0000-4000-8000-000000000004',
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    }),
  );
}

describe('DesktopHistoryHandlers', () => {
  beforeAll(async () => {
    ({ DesktopHistoryHandlers } = (await import(
      moduleFileUrl(desktopSourcePath('main', 'desktopHistoryHandlers.ts'))
    )) as DesktopHistoryHandlersModule);
  });

  beforeEach(() => {
    clearStoreCache();
    chatExportMocks.constructorDeps.length = 0;
    chatExportMocks.constructorError = undefined;
    vi.resetAllMocks();
    historyMocks.buildHistoryMessage.mockResolvedValue({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: [],
    });
  });

  it('posts the current history message to the renderer', async () => {
    const postToRenderer = vi.fn();
    const controller = createHistoryController({ postToRenderer });

    await controller.postHistoryData();

    expect(historyMocks.buildHistoryMessage).toHaveBeenCalledOnce();
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: [],
    });
  });

  it('reruns a persisted history configuration through the execution port', async () => {
    await writeHistoryConfig();
    const runExecution = vi.fn(async () => undefined);
    const showInfoMessage = vi.fn(async () => undefined);
    const actions = createHistoryActions({
      history: { runExecution },
      showInfoMessage,
    });

    await assertSupported(actions.rerunAgent)({
      command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
      historyId: HISTORY_ID,
    });

    expect(showInfoMessage).toHaveBeenCalledWith(
      'Rerunning agent from history',
    );
    expect(runExecution).toHaveBeenCalledWith({
      config: HISTORY_CONFIG,
      executionId: undefined,
    });
  });

  it('protects an active execution from deletion', async () => {
    await writeHistoryConfig();
    await writeForeignLease(HISTORY_ID);
    const postToRenderer = vi.fn();
    const showInfoMessage = vi.fn(async () => undefined);
    const actions = createHistoryActions({
      postToRenderer,
      showInfoMessage,
    });

    await assertSupported(actions.deleteAgent)(HISTORY_ID);

    expect(await getExecutionStore(HISTORY_ID).readConfig()).toEqual(
      HISTORY_CONFIG,
    );
    expect(showInfoMessage).toHaveBeenCalledWith(
      'Cannot delete an execution that is active in TeXRA',
    );
    expect(postToRenderer).not.toHaveBeenCalled();
  });

  it('deletes an inactive execution and refreshes history', async () => {
    await writeHistoryConfig();
    const postToRenderer = vi.fn();
    const actions = createHistoryActions({ postToRenderer });

    await assertSupported(actions.deleteAgent)(HISTORY_ID);

    expect(await getExecutionStore(HISTORY_ID).readConfig()).toBeNull();
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: [],
    });
  });

  it('clears inactive history while preserving active executions', async () => {
    const activeHistoryId = 'cccc3333';
    const inactiveHistoryId = 'dddd4444';
    await Promise.all([
      getExecutionStore(activeHistoryId).writeConfig(HISTORY_CONFIG),
      getExecutionStore(inactiveHistoryId).writeConfig(HISTORY_CONFIG),
    ]);
    await writeForeignLease(activeHistoryId);
    const postToRenderer = vi.fn();
    const showInfoMessage = vi.fn(async () => undefined);
    const actions = createHistoryActions({
      postToRenderer,
      showInfoMessage,
    });

    await assertSupported(actions.clear)();

    expect(await getExecutionStore(activeHistoryId).readConfig()).toEqual(
      HISTORY_CONFIG,
    );
    expect(await getExecutionStore(inactiveHistoryId).readConfig()).toBeNull();
    expect(showInfoMessage).toHaveBeenCalledWith(
      'Cleared stored history except for 1 active execution.',
    );
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: [],
    });
  });

  it("restores a history item's setup into the main view", async () => {
    await writeHistoryConfig();
    const showErrorMessage = vi.fn();
    const restoreTaskState = vi.fn(async () => true);
    const actions = createHistoryActions({
      showErrorMessage,
      history: { restoreTaskState },
    });

    await assertSupported(actions.restoreAgent)({
      command: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
      historyId: HISTORY_ID,
    });

    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(restoreTaskState).toHaveBeenCalledWith({
      agentConfig: HISTORY_CONFIG,
    });
  });

  it('reports missing history items for rerun and restore instead of dropping them', async () => {
    const showErrorMessage = vi.fn();
    const actions = createHistoryActions({ showErrorMessage });
    const historyId = 'ffff9999';

    await assertSupported(actions.rerunAgent)({
      command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
      historyId,
    });
    await assertSupported(actions.restoreAgent)({
      command: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
      historyId,
    });

    expect(showErrorMessage).toHaveBeenCalledTimes(2);
    expect(showErrorMessage).toHaveBeenNthCalledWith(
      1,
      'History item not found or unreadable (missing, corrupt, or from an incompatible version)',
    );
    expect(showErrorMessage).toHaveBeenNthCalledWith(
      2,
      'History item not found or unreadable (missing, corrupt, or from an incompatible version)',
    );
  });

  it('reports when restoring the task state fails', async () => {
    await writeHistoryConfig();
    const showErrorMessage = vi.fn();
    const restoreTaskState = vi.fn(async () => false);
    const actions = createHistoryActions({
      showErrorMessage,
      history: { restoreTaskState },
    });

    await assertSupported(actions.restoreAgent)({
      command: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
      historyId: HISTORY_ID,
    });

    expect(restoreTaskState).toHaveBeenCalledWith({
      agentConfig: HISTORY_CONFIG,
    });
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Failed to restore configuration',
    );
  });

  it('exports a history chat to Markdown via the shared ChatExportController', async () => {
    chatExportMocks.buildExportInput.mockResolvedValue({
      status: 'ok',
      exportInput: EXPORT_INPUT,
    });
    chatExportMocks.exportAsMarkdown.mockResolvedValue({
      storagePath: 'executions/abc/chat.md',
      absolutePath: '/tmp/executions/abc/chat.md',
    });
    const openPath = vi.fn();
    const showInfoMessage = vi.fn();
    const actions = createHistoryActions({ openPath, showInfoMessage });

    await assertSupported(actions.exportChatMd)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
      historyId: 'abc',
    });

    expect(chatExportMocks.buildExportInput).toHaveBeenCalledWith('abc');
    expect(chatExportMocks.exportAsMarkdown).toHaveBeenCalledWith(
      'abc',
      EXPORT_INPUT,
    );
    expect(openPath).toHaveBeenCalledWith('/tmp/executions/abc/chat.md');
    expect(showInfoMessage).toHaveBeenCalledWith('Chat exported: chat.md');
    expect(chatExportMocks.constructorDeps.at(-1)).toMatchObject({
      latexPreamble: expect.stringContaining('\\documentclass'),
    });
  });

  it('shares the controller load across concurrent first exports', async () => {
    chatExportMocks.buildExportInput.mockResolvedValue({
      status: 'ok',
      exportInput: EXPORT_INPUT,
    });
    chatExportMocks.exportAsMarkdown.mockResolvedValue({
      storagePath: 'executions/abc/chat.md',
      absolutePath: '/tmp/executions/abc/chat.md',
    });
    const actions = createHistoryActions();

    await Promise.all([
      assertSupported(actions.exportChatMd)({
        command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
        historyId: 'abc',
      }),
      assertSupported(actions.exportChatMd)({
        command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
        historyId: 'def',
      }),
    ]);

    expect(chatExportMocks.constructorDeps).toHaveLength(1);
    expect(chatExportMocks.buildExportInput).toHaveBeenCalledTimes(2);
  });

  it('retries controller construction after the first load fails', async () => {
    chatExportMocks.buildExportInput.mockResolvedValue({
      status: 'ok',
      exportInput: EXPORT_INPUT,
    });
    chatExportMocks.exportAsMarkdown.mockResolvedValue({
      storagePath: 'executions/def/chat.md',
      absolutePath: '/tmp/executions/def/chat.md',
    });
    chatExportMocks.constructorError = new Error('controller setup failed');
    const actions = createHistoryActions();
    const exportChatMd = assertSupported(actions.exportChatMd);

    await expect(
      exportChatMd({
        command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
        historyId: 'abc',
      }),
    ).rejects.toThrow('controller setup failed');
    await expect(
      exportChatMd({
        command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
        historyId: 'def',
      }),
    ).resolves.toBeUndefined();

    expect(chatExportMocks.constructorDeps).toHaveLength(2);
    expect(chatExportMocks.buildExportInput).toHaveBeenCalledOnce();
    expect(chatExportMocks.buildExportInput).toHaveBeenCalledWith('def');
  });

  it('falls back to opening the .tex source when LaTeX compilation fails', async () => {
    chatExportMocks.buildExportInput.mockResolvedValue({
      status: 'ok',
      exportInput: EXPORT_INPUT,
    });
    chatExportMocks.exportAsLatex.mockResolvedValue({
      storagePath: 'executions/abc/chat.tex',
      absolutePath: '/tmp/executions/abc/chat.tex',
      pdfPath: undefined,
      logTail: '! Undefined control sequence.',
    });
    const openPath = vi.fn();
    const showInfoMessage = vi.fn();
    const actions = createHistoryActions({ openPath, showInfoMessage });

    await assertSupported(actions.exportChatTex)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
      historyId: 'abc',
    });

    expect(openPath).toHaveBeenCalledWith('/tmp/executions/abc/chat.tex');
    expect(showInfoMessage).toHaveBeenCalledWith(
      'LaTeX compilation failed. The .tex source file has been opened instead.',
    );
  });

  it('exports a history chat to HTML via the shared trace-viewer template', async () => {
    chatExportMocks.exportAsHtml.mockResolvedValue({
      status: 'ok',
      result: {
        storagePath: 'executions/abc/chat.html',
        absolutePath: '/tmp/executions/abc/chat.html',
      },
    });
    const openPath = vi.fn();
    const actions = createHistoryActions({ openPath });

    await assertSupported(actions.exportChatHtml)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML,
      historyId: 'abc',
    });

    expect(chatExportMocks.exportAsHtml).toHaveBeenCalledWith(
      'abc',
      `${RESOURCES_PATH}/traceViewerStandalone/index.html`,
    );
    expect(openPath).toHaveBeenCalledWith('/tmp/executions/abc/chat.html');
  });

  it('reports a missing history item on export instead of throwing', async () => {
    chatExportMocks.buildExportInput.mockResolvedValue({
      status: 'config_missing',
    });
    const showInfoMessage = vi.fn();
    const actions = createHistoryActions({ showInfoMessage });

    await assertSupported(actions.exportChatMd)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
      historyId: 'missing',
    });

    expect(showInfoMessage).toHaveBeenCalledWith('History item not found');
  });
});
