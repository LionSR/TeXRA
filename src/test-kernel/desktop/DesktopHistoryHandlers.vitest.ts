import { join } from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { ChatExportInput } from '@controllers/settingsView/ChatExportController';
import type { DesktopHistoryOptions } from '@desktop/main/desktopHistoryHandlers';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';
import { assertSupported } from '@shared/utils/dispatcher';
import { writeForeignLease } from '@test/support/executionLeaseFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import { GoalStore } from '@tools/goal';

import { createStubDesktopHistoryOptions } from './desktopSettingsTestSupport';
import { repoPath } from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

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
  'resourcesPath' | 'runExecution' | 'restoreRunConfig'
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

function createHistoryHandlers(overrides: DesktopHistoryActionOverrides = {}) {
  return createHistoryController(overrides).handlers;
}

async function writeHistoryConfig(): Promise<void> {
  await getExecutionStore(HISTORY_ID).writeRunRecord(HISTORY_CONFIG);
}

type HistoryHandlers = ReturnType<typeof createHistoryHandlers>;

async function deleteAgent(
  actions: HistoryHandlers,
  historyId: string,
): Promise<void> {
  await assertSupported(actions.deleteAgent)({
    command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
    historyId,
  });
}

async function clearHistory(actions: HistoryHandlers): Promise<void> {
  await assertSupported(actions.clearHistory)({
    command: SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY,
  });
}

async function restoreAgent(
  actions: HistoryHandlers,
  historyId: string,
): Promise<void> {
  await assertSupported(actions.restoreAgent)({
    command: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
    historyId,
  });
}

async function exportChatMd(
  actions: HistoryHandlers,
  historyId: string,
): Promise<void> {
  await assertSupported(actions.exportChatMd)({
    command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
    historyId,
  });
}

function stubSuccessfulExportInput(): void {
  chatExportMocks.buildExportInput.mockResolvedValue({
    status: 'ok',
    exportInput: EXPORT_INPUT,
  });
}

function stubMarkdownExport(historyId: string): void {
  chatExportMocks.exportAsMarkdown.mockResolvedValue({
    storagePath: `executions/${historyId}/chat.md`,
    absolutePath: `/tmp/executions/${historyId}/chat.md`,
  });
}

describe('DesktopHistoryHandlers', () => {
  beforeAll(async () => {
    ({ DesktopHistoryHandlers } = await loadSourceModule(
      '@desktop/main/desktopHistoryHandlers',
    ));
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
    const actions = createHistoryHandlers({
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

  it('warns instead of deleting an active execution', async () => {
    await writeHistoryConfig();
    await writeForeignLease(HISTORY_ID);
    const postToRenderer = vi.fn();
    const showWarningMessage = vi.fn(async () => undefined);
    const actions = createHistoryHandlers({
      postToRenderer,
      showWarningMessage,
    });

    await deleteAgent(actions, HISTORY_ID);

    expect(await getExecutionStore(HISTORY_ID).readConfig()).toEqual(
      HISTORY_CONFIG,
    );
    expect(showWarningMessage).toHaveBeenCalledWith(
      'Cannot delete an execution that is active in TeXRA',
    );
    expect(postToRenderer).not.toHaveBeenCalled();
  });

  it('warns when the history item to delete no longer exists', async () => {
    const showWarningMessage = vi.fn(async () => undefined);
    const actions = createHistoryHandlers({ showWarningMessage });

    await deleteAgent(actions, 'eeee5555');

    expect(showWarningMessage).toHaveBeenCalledWith(
      'History item not found: eeee5555',
    );
  });

  it('deletes an inactive execution and refreshes history', async () => {
    await writeHistoryConfig();
    const postToRenderer = vi.fn();
    const actions = createHistoryHandlers({ postToRenderer });

    await deleteAgent(actions, HISTORY_ID);

    expect(await getExecutionStore(HISTORY_ID).readConfig()).toBeNull();
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: [],
    });
  });

  it('routes stream cleanup through the live session owner', async () => {
    await writeHistoryConfig();
    const streamId = `chat@deepseek#${HISTORY_ID}` as StreamTabId;
    await getExecutionStore(HISTORY_ID).writeMeta({
      timestamp: '2026-01-01T00:00:00.000Z',
      streamId,
    });
    const deleteAdjacentStreamState = vi.fn(async () => undefined);
    const actions = createHistoryHandlers({
      getLiveStreamCleanup: () => ({ deleteAdjacentStreamState }),
    });

    await deleteAgent(actions, HISTORY_ID);

    expect(deleteAdjacentStreamState).toHaveBeenCalledWith(streamId);
  });

  it('drops the goal owned by a deleted execution', async () => {
    await writeHistoryConfig();
    const streamId = `chat@deepseek#${HISTORY_ID}` as StreamTabId;
    const survivor = 'chat@deepseek#ffff8888' as StreamTabId;
    await GoalStore.start(streamId, 'finish the cleanup');
    await GoalStore.start(survivor, 'keep me');
    const actions = createHistoryHandlers();

    await deleteAgent(actions, HISTORY_ID);

    expect(GoalStore.getForStream(streamId)).toBeNull();
    expect(GoalStore.getForStream(survivor)?.objective).toBe('keep me');
  });

  it('confirms a full clear and drops the goals of every cleared execution', async () => {
    await writeHistoryConfig();
    const streamId = `chat@deepseek#${HISTORY_ID}` as StreamTabId;
    await GoalStore.start(streamId, 'finish the cleanup');
    const postToRenderer = vi.fn();
    const showInfoMessage = vi.fn(async () => undefined);
    const actions = createHistoryHandlers({ postToRenderer, showInfoMessage });

    await clearHistory(actions);

    expect(GoalStore.getForStream(streamId)).toBeNull();
    expect(showInfoMessage).toHaveBeenCalledWith('Agent history cleared');
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
    });
  });

  it('leaves history untouched when the user cancels the clear prompt', async () => {
    await writeHistoryConfig();
    const showInfoMessage = vi.fn(async () => undefined);
    const confirmAction = vi.fn(async () => false);
    const actions = createHistoryHandlers({ showInfoMessage, confirmAction });

    await clearHistory(actions);

    expect(confirmAction).toHaveBeenCalledWith(
      'Clear all history? This deletes every stored execution and cannot be undone.',
      'Clear all history',
    );
    expect(await getExecutionStore(HISTORY_ID).readConfig()).toEqual(
      HISTORY_CONFIG,
    );
    expect(showInfoMessage).not.toHaveBeenCalled();
  });

  it('clears inactive history while preserving active executions', async () => {
    const activeHistoryId = 'cccc3333';
    const inactiveHistoryId = 'dddd4444';
    await Promise.all([
      getExecutionStore(activeHistoryId).writeRunRecord(HISTORY_CONFIG),
      getExecutionStore(inactiveHistoryId).writeRunRecord(HISTORY_CONFIG),
    ]);
    await writeForeignLease(activeHistoryId);
    const postToRenderer = vi.fn();
    const showInfoMessage = vi.fn(async () => undefined);
    const actions = createHistoryHandlers({
      postToRenderer,
      showInfoMessage,
    });

    await clearHistory(actions);

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
    const restoreRunConfig = vi.fn(async () => true);
    const actions = createHistoryHandlers({
      showErrorMessage,
      history: { restoreRunConfig },
    });

    await restoreAgent(actions, HISTORY_ID);

    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(restoreRunConfig).toHaveBeenCalledWith(HISTORY_CONFIG);
  });

  it('reports missing history items for rerun and restore instead of dropping them', async () => {
    const showErrorMessage = vi.fn();
    const actions = createHistoryHandlers({ showErrorMessage });
    const historyId = 'ffff9999';
    const notFoundMessage =
      'History item not found or unreadable (missing, corrupt, or from an incompatible version)';

    await assertSupported(actions.rerunAgent)({
      command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
      historyId,
    });
    await restoreAgent(actions, historyId);

    expect(showErrorMessage).toHaveBeenCalledTimes(2);
    expect(showErrorMessage).toHaveBeenNthCalledWith(1, notFoundMessage);
    expect(showErrorMessage).toHaveBeenNthCalledWith(2, notFoundMessage);
  });

  it('reports when restoring the run config fails', async () => {
    await writeHistoryConfig();
    const showErrorMessage = vi.fn();
    const restoreRunConfig = vi.fn(async () => false);
    const actions = createHistoryHandlers({
      showErrorMessage,
      history: { restoreRunConfig },
    });

    await restoreAgent(actions, HISTORY_ID);

    expect(restoreRunConfig).toHaveBeenCalledWith(HISTORY_CONFIG);
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Failed to restore configuration',
    );
  });

  it('exports a history chat to Markdown via the shared ChatExportController', async () => {
    stubSuccessfulExportInput();
    stubMarkdownExport('abc');
    const openPath = vi.fn();
    const showInfoMessage = vi.fn();
    const actions = createHistoryHandlers({ openPath, showInfoMessage });

    await exportChatMd(actions, 'abc');

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
    stubSuccessfulExportInput();
    stubMarkdownExport('abc');
    const actions = createHistoryHandlers();

    await Promise.all([
      exportChatMd(actions, 'abc'),
      exportChatMd(actions, 'def'),
    ]);

    expect(chatExportMocks.constructorDeps).toHaveLength(1);
    expect(chatExportMocks.buildExportInput).toHaveBeenCalledTimes(2);
  });

  it('retries controller construction after the first load fails', async () => {
    stubSuccessfulExportInput();
    stubMarkdownExport('def');
    chatExportMocks.constructorError = new Error('controller setup failed');
    const actions = createHistoryHandlers();

    await expect(exportChatMd(actions, 'abc')).rejects.toThrow(
      'controller setup failed',
    );
    await expect(exportChatMd(actions, 'def')).resolves.toBeUndefined();

    expect(chatExportMocks.constructorDeps).toHaveLength(2);
    expect(chatExportMocks.buildExportInput).toHaveBeenCalledOnce();
    expect(chatExportMocks.buildExportInput).toHaveBeenCalledWith('def');
  });

  it('falls back to opening the .tex source when LaTeX compilation fails', async () => {
    stubSuccessfulExportInput();
    chatExportMocks.exportAsLatex.mockResolvedValue({
      storagePath: 'executions/abc/chat.tex',
      absolutePath: '/tmp/executions/abc/chat.tex',
      pdfPath: undefined,
      logTail: '! Undefined control sequence.',
    });
    const openPath = vi.fn();
    const showWarningMessage = vi.fn();
    const actions = createHistoryHandlers({ openPath, showWarningMessage });

    await assertSupported(actions.exportChatTex)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
      historyId: 'abc',
    });

    expect(openPath).toHaveBeenCalledWith('/tmp/executions/abc/chat.tex');
    expect(showWarningMessage).toHaveBeenCalledWith(
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
    const actions = createHistoryHandlers({ openPath });

    await assertSupported(actions.exportChatHtml)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML,
      historyId: 'abc',
    });

    expect(chatExportMocks.exportAsHtml).toHaveBeenCalledWith(
      'abc',
      join(RESOURCES_PATH, 'traceViewer', 'index.html'),
    );
    expect(openPath).toHaveBeenCalledWith('/tmp/executions/abc/chat.html');
  });

  it('reports a missing history item on export instead of throwing', async () => {
    chatExportMocks.buildExportInput.mockResolvedValue({
      status: 'config_missing',
    });
    const showErrorMessage = vi.fn();
    const actions = createHistoryHandlers({ showErrorMessage });

    await exportChatMd(actions, 'missing');

    expect(showErrorMessage).toHaveBeenCalledWith('History item not found');
  });
});
