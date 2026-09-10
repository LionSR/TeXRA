import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';

import { beforeEach, describe, expect, it } from 'vitest';

import { getRunRecords } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/runTab';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
} from '@shared/schemas';
import type { RunId, RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { StreamLogStore } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

const TEMPLATE =
  '<!doctype html><html><head><title>t</title>' +
  '<script type="module" crossorigin src="./index.js"></script>' +
  '</head><body></body></html>';

const tempDirs = useTempDirs();
let session: ReturnType<typeof createTestSession>;

async function installStoragePlatform(): Promise<void> {
  const tempDir = await makeTempDir('texra-html-export-', tempDirs);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  const storage = new WorkspaceStorageProvider(storageRoot, workspaceDir);
  await installPlatform(
    { workspacePath: workspaceDir, storagePath: storage.getStoragePath() },
    {
      fs: nodeFilesystem,
      storage,
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );
}

async function writeTemplate(): Promise<string> {
  const tempDir = await makeTempDir('texra-template-', tempDirs);
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
    cli: { outputFile: null, multiAgentPresetId: null },
    ...overrides,
  };
}

async function persistTranscriptEntry(
  runId: RunId,
  agent: string,
): Promise<RunId> {
  const runId = getStreamTabId(agent, { runId });
  await Effect.runPromise(
    session.commit([
      {
        type: 'log',
        aggregateId: aggregateId('stream', runId),
        level: LOG_LEVELS.INFO,
        messageType: MESSAGE_TYPES.USER_MESSAGE,
        message: 'hello',
      },
    ]),
  );

  return runId;
}

describe('ChatExportController.exportAsHtml', () => {
  let controller: ChatExportController;

  beforeEach(async () => {
    await installStoragePlatform();
    session = createTestSession({ roots: processWorkspaceRoots() });
    controller = new ChatExportController({
      latexPreamble: '',
      session,
    });
  });

  it('returns config_missing when nothing is stored', async () => {
    const templatePath = await writeTemplate();

    const outcome = await Effect.runPromise(
      controller.exportAsHtml('missing', templatePath),
    );

    expect(outcome).toEqual({ status: 'config_missing' });
  });

  it('writes a self-contained HTML file with the trace embedded, when everything is present', async () => {
    const templatePath = await writeTemplate();
    const runId = 'eec001' as RunId;
    const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });
    publishTestRunStart(
      session,
      getStreamTabId(runConfigRecord.agent, { runId }),
      runId,
    );
    await session.settlePublications();
    await Effect.runPromise(
      getRunRecords(session, runId).writeRunRecord(runConfigRecord),
    );
    const runId = await persistTranscriptEntry(runId, 'review');

    const outcome = await Effect.runPromise(
      controller.exportAsHtml(runId, templatePath),
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.result.storagePath).toMatch(
      /^executions\/eec001\/texra-chat-.*\.html$/,
    );

    const written = await nodeFilesystem.readFile(outcome.result.absolutePath);
    const html = new TextDecoder().decode(written);
    expect(html).toContain('<script>window.__TEXRA_TRACE__');
    expect(html).toContain('"text":"hello"');
    expect(html).toContain(
      '<script type="module" crossorigin src="./index.js">',
    );
  });

  it('throws when the standalone template bundle is missing', async () => {
    const runId = 'eec002' as RunId;
    publishTestRunStart(
      session,
      getStreamTabId(config().agent, { runId }),
      runId,
    );
    await session.settlePublications();
    await Effect.runPromise(
      getRunRecords(session, runId).writeRunRecord(config()),
    );
    const runId = await persistTranscriptEntry(runId, 'orchestrator');

    await expect(
      Effect.runPromise(
        controller.exportAsHtml(runId, '/nonexistent/index.html'),
      ),
    ).rejects.toThrow(/Trace-viewer standalone bundle missing/);
  });
});

describe('ChatExportController.buildExportInput', () => {
  let controller: ChatExportController;

  beforeEach(async () => {
    await installStoragePlatform();
    session = createTestSession({ roots: processWorkspaceRoots() });
    controller = new ChatExportController({
      latexPreamble: '',
      session,
    });
  });

  it('reports config_missing when nothing is stored', async () => {
    await expect(
      Effect.runPromise(controller.buildExportInput('missing')),
    ).resolves.toEqual({
      status: 'config_missing',
    });
  });

  it('returns ok when config and transcript are stored', async () => {
    const runId = 'eec001' as RunId;
    publishTestRunStart(
      session,
      getStreamTabId(config().agent, { runId }),
      runId,
    );
    await session.settlePublications();
    await Effect.runPromise(
      getRunRecords(session, runId).writeRunRecord(config()),
    );
    const runId = await persistTranscriptEntry(runId, 'orchestrator');

    await expect(
      Effect.runPromise(controller.buildExportInput(runId)),
    ).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('reports conversation_missing when a config is stored but no transcript exists', async () => {
    const runId = 'eec003' as RunId;
    publishTestRunStart(
      session,
      getStreamTabId(config().agent, { runId }),
      runId,
    );
    await session.settlePublications();
    await Effect.runPromise(
      getRunRecords(session, runId).writeRunRecord(config()),
    );

    await expect(
      Effect.runPromise(controller.buildExportInput(runId)),
    ).resolves.toEqual({
      status: 'conversation_missing',
    });
  });
});
