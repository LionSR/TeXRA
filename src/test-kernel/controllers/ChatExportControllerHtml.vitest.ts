import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { ChatExportController } from '@controllers/settingsView/ChatExportController';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { createFakePlatform } from '@test/support/FakePlatform';
import { StreamLogStore } from '@transcript';
import { StorageFS } from '@utils/files';

const TEMPLATE =
  '<!doctype html><html><head><title>t</title>' +
  '<script type="module" crossorigin src="./index.js"></script>' +
  '</head><body></body></html>';

const tempDirs: string[] = [];

async function installStoragePlatform(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-html-export-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      { workspacePath: workspaceDir },
      {
        fs: nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
        globalState: new MemoryStateStore(),
        workspaceState: new MemoryStateStore(),
      },
    ),
  );
}

async function writeTemplate(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-template-'));
  tempDirs.push(tempDir);
  const templatePath = path.join(tempDir, 'index.html');
  await writeFile(templatePath, TEMPLATE, 'utf8');
  return templatePath;
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    inputFiles: [],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    editedFile: null,
    agent: 'orchestrator',
    model: 'deepseekT',
    instruction: 'Solve the problem.',
    agentCategory: AgentCategory.ToolUse,
    editedFiles: [],
    toolConfig: DEFAULT_TOOL_CONFIG,
    memories: [],
    workingDirectory: '/workspace',
    cliOutputFile: null,
    cliMultiAgentPresetId: null,
    ...overrides,
  };
}

describe('ChatExportController.exportAsHtml', () => {
  const controller = new ChatExportController({ latexPreamble: '' });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('returns config_missing when nothing is stored', async () => {
    await installStoragePlatform();
    const templatePath = await writeTemplate();

    const outcome = await controller.exportAsHtml('missing', templatePath);

    expect(outcome).toEqual({ status: 'config_missing' });
  });

  it('returns streamLogs_missing when config exists but no transcript was persisted', async () => {
    await installStoragePlatform();
    const templatePath = await writeTemplate();
    await getExecutionStore('exec-missing-logs' as ExecutionId).writeConfig(
      config(),
    );

    const outcome = await controller.exportAsHtml(
      'exec-missing-logs',
      templatePath,
    );

    expect(outcome).toEqual({ status: 'streamLogs_missing' });
  });

  it('writes a self-contained HTML file with the trace embedded, when everything is present', async () => {
    await installStoragePlatform();
    const templatePath = await writeTemplate();
    const executionId = 'exec-full' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    await getExecutionStore(executionId).writeConfig(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
    });

    const streamId = getStreamTabId('review', 'sonnet46T', { executionId });
    const store = await StreamLogStore.open();
    store.append(streamId, {
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'hello',
    });
    await store.flush();

    const outcome = await controller.exportAsHtml(executionId, templatePath);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.result.storagePath).toMatch(
      /^executions\/exec-full\/texra-chat-.*\.html$/,
    );

    const written = await nodeFilesystem.readFile(
      StorageFS.fullPath(outcome.result.storagePath),
    );
    const html = new TextDecoder().decode(written);
    expect(html).toContain('<script>window.__TEXRA_TRACE__');
    expect(html).toContain('"id":"entry-1"');
    expect(html).toContain(
      '<script type="module" crossorigin src="./index.js">',
    );
  });

  it('throws when the standalone template bundle is missing', async () => {
    await installStoragePlatform();
    const executionId = 'exec-missing-template' as ExecutionId;
    await getExecutionStore(executionId).writeConfig(config());
    const store = await StreamLogStore.open();
    const streamId = getStreamTabId('orchestrator', 'deepseekT', {
      executionId,
    });
    store.append(streamId, {
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'hello',
    });
    await store.flush();

    await expect(
      controller.exportAsHtml(executionId, '/nonexistent/index.html'),
    ).rejects.toThrow(/Trace-viewer standalone bundle missing/);
  });
});
