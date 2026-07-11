// Third-party imports
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - history dependencies
import { setupPlatform } from '@test/support/setupPlatform';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
import { assertSupported } from '@shared/utils/dispatcher';

// Local imports - desktop test support
import {
  desktopSourcePath,
  moduleFileUrl,
  repoPath,
} from './desktopTestPaths.mjs';

// Local imports - controller types
import type { ChatExportInput } from '@controllers/settingsView/ChatExportController';

const chatExportMocks = vi.hoisted(() => ({
  buildExportInput: vi.fn(),
  exportAsMarkdown: vi.fn(),
  exportAsLatex: vi.fn(),
  exportAsHtml: vi.fn(),
  constructorDeps: [] as unknown[],
  constructorError: undefined as Error | undefined,
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

type DesktopHistoryHandlersModule =
  typeof import('@desktop/main/desktopHistoryHandlers');
type DesktopHistoryDependencies = ConstructorParameters<
  DesktopHistoryHandlersModule['DesktopHistoryHandlers']
>[0];

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

function createHistoryActions(
  overrides: Partial<DesktopHistoryDependencies> = {},
) {
  return new DesktopHistoryHandlers({
    postToRenderer: vi.fn(),
    resourcesPath: RESOURCES_PATH,
    onError: vi.fn(),
    ...overrides,
  }).actions;
}

async function writeHistoryConfig(): Promise<void> {
  await getExecutionStore(HISTORY_ID).writeConfig(HISTORY_CONFIG);
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
  });

  it("restores a history item's setup into the main view", async () => {
    await writeHistoryConfig();
    const showErrorMessage = vi.fn();
    const restoreTaskState = vi.fn(async () => true);
    const actions = createHistoryActions({
      showErrorMessage,
      restoreTaskState,
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

  it('errors instead of a false success when rerun has no runExecution dependency wired (Copilot #7827)', async () => {
    await writeHistoryConfig();
    const showInfoMessage = vi.fn();
    const showErrorMessage = vi.fn();
    const actions = createHistoryActions({
      showInfoMessage,
      showErrorMessage,
    });

    await assertSupported(actions.rerunAgent)({
      command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
      historyId: HISTORY_ID,
    });

    expect(showInfoMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Rerunning agents from history is not available in this build',
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
