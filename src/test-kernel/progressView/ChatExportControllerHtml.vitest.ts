import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
} from '@shared/schemas';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createFakePlatform } from '@test/support/FakePlatform';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

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

async function persistTranscriptEntry(
  executionId: ExecutionId,
  agent: string,
): Promise<StreamTabId> {
  const streamId = getStreamTabId(agent, { executionId });
  const store = await StreamLogStore.open();
  appendTranscriptEntry(store, streamId, {
    id: 'entry-1',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.DEFAULT,
    text: 'hello',
  });
  await store.flush();
  return streamId;
}

describe('ChatExportController.exportAsHtml', () => {
  const controller = new ChatExportController({ latexPreamble: '' });

  async function expectStreamLogsMissing(
    executionId: ExecutionId,
  ): Promise<void> {
    const outcome = await controller.exportAsHtml(
      executionId,
      await writeTemplate(),
    );
    expect(outcome).toEqual({ status: 'streamLogs_missing' });
  }

  beforeEach(installStoragePlatform);

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('returns config_missing when nothing is stored', async () => {
    const templatePath = await writeTemplate();

    const outcome = await controller.exportAsHtml('missing', templatePath);

    expect(outcome).toEqual({ status: 'config_missing' });
  });

  it('returns streamLogs_missing when metadata carries no stamped stream id', async () => {
    await getExecutionStore('exec-missing-logs' as ExecutionId).writeRunRecord(
      config(),
    );

    await expectStreamLogsMissing('exec-missing-logs' as ExecutionId);
  });

  it('never resolves a transcript from sidecar candidates without a stamped stream id', async () => {
    const executionId = 'aaa555aaa555' as ExecutionId;
    const executionConfig = config();
    await getExecutionStore(executionId).writeRunRecord(executionConfig);

    const first = `orchestrator@old#${executionId}` as StreamTabId;
    const second = `orchestrator@new#${executionId}` as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    const facts = snapshotFacts(snapshots);
    facts.setRunConfig(first, executionConfig, executionId);
    facts.setRunConfig(second, executionConfig, executionId);
    await snapshots.flush();

    await expectStreamLogsMissing(executionId);
  });

  it('returns streamLogs_missing when only delegated child sidecars remain', async () => {
    const executionId = 'aaa556aaa556' as ExecutionId;
    const executionConfig = config();
    await getExecutionStore(executionId).writeRunRecord(executionConfig);

    const parent = 'orchestrator@model#parent' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    const facts = snapshotFacts(snapshots);
    for (const streamId of [
      `bash@tool#${executionId}`,
      `codex@tool#${executionId}`,
    ] as StreamTabId[]) {
      facts.setRunConfig(streamId, executionConfig, executionId);
      facts.setParentStream(streamId, parent);
    }
    await snapshots.flush();

    await expectStreamLogsMissing(executionId);
  });

  it('writes a self-contained HTML file with the trace embedded, when everything is present', async () => {
    const templatePath = await writeTemplate();
    const executionId = 'exec-full' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    await getExecutionStore(executionId).writeRunRecord(executionConfig);
    const streamId = await persistTranscriptEntry(executionId, 'review');
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
      streamId,
    });

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
    const executionId = 'exec-missing-template' as ExecutionId;
    await getExecutionStore(executionId).writeRunRecord(config());
    const streamId = await persistTranscriptEntry(executionId, 'orchestrator');
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      streamId,
    });

    await expect(
      controller.exportAsHtml(executionId, '/nonexistent/index.html'),
    ).rejects.toThrow(/Trace-viewer standalone bundle missing/);
  });
});
