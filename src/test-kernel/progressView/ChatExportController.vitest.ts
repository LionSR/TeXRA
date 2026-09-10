import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { beforeEach, describe, expect } from 'vitest';

import { getRunRecords } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
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
import type { RunId, StreamTabId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { RunLogStore } from '@transcript';
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

function persistTranscriptEntry(
  executionId: RunId,
): Effect.Effect<StreamTabId> {
  return Effect.gen(function* () {
    const streamId = executionId;
    yield* session.commit([
      {
        type: 'log',
        aggregateId: aggregateId('stream', streamId),
        level: LOG_LEVELS.INFO,
        messageType: MESSAGE_TYPES.USER_MESSAGE,
        message: 'hello',
      },
    ]);

    return streamId;
  });
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

  it.live('returns config_missing when nothing is stored', () =>
    Effect.gen(function* () {
      const templatePath = yield* Effect.promise(() => writeTemplate());

      const outcome = yield* controller.exportAsHtml('missing', templatePath);

      expect(outcome).toEqual({ status: 'config_missing' });
    }),
  );

  it.live(
    'writes a self-contained HTML file with the trace embedded, when everything is present',
    () =>
      Effect.gen(function* () {
        const templatePath = yield* Effect.promise(() => writeTemplate());
        const executionId = 'eec001' as RunId;
        const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
        publishTestRunStart(session, executionId, executionId);
        yield* Effect.promise(() => session.settlePublications());
        yield* getRunRecords(session, executionId).writeRunRecord(
          executionConfig,
        );
        const streamId = yield* persistTranscriptEntry(executionId);

        const outcome = yield* controller.exportAsHtml(
          executionId,
          templatePath,
        );

        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;
        expect(outcome.result.storagePath).toMatch(
          /^executions\/eec001\/texra-chat-.*\.html$/,
        );

        const written = yield* Effect.promise(() =>
          nodeFilesystem.readFile(outcome.result.absolutePath),
        );
        const html = new TextDecoder().decode(written);
        expect(html).toContain('<script>window.__TEXRA_TRACE__');
        expect(html).toContain('"text":"hello"');
        expect(html).toContain(
          '<script type="module" crossorigin src="./index.js">',
        );
      }),
  );

  it.live('throws when the standalone template bundle is missing', () =>
    Effect.gen(function* () {
      const executionId = 'eec002' as RunId;
      publishTestRunStart(session, executionId, executionId);
      yield* Effect.promise(() => session.settlePublications());
      yield* getRunRecords(session, executionId).writeRunRecord(config());
      const streamId = yield* persistTranscriptEntry(executionId);

      const failure = yield* Effect.flip(
        controller.exportAsHtml(executionId, '/nonexistent/index.html'),
      );
      expect(failure.message).toMatch(/Trace-viewer standalone bundle missing/);
    }),
  );
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

  it.live('reports config_missing when nothing is stored', () =>
    Effect.gen(function* () {
      expect(yield* controller.buildExportInput('missing')).toEqual({
        status: 'config_missing',
      });
    }),
  );

  it.live('returns ok when config and transcript are stored', () =>
    Effect.gen(function* () {
      const executionId = 'eec001' as RunId;
      publishTestRunStart(session, executionId, executionId);
      yield* Effect.promise(() => session.settlePublications());
      yield* getRunRecords(session, executionId).writeRunRecord(config());
      const streamId = yield* persistTranscriptEntry(executionId);

      expect(yield* controller.buildExportInput(executionId)).toMatchObject({
        status: 'ok',
      });
    }),
  );

  it.live(
    'reports conversation_missing when a config is stored but no transcript exists',
    () =>
      Effect.gen(function* () {
        const executionId = 'eec003' as RunId;
        publishTestRunStart(session, executionId, executionId);
        yield* Effect.promise(() => session.settlePublications());
        yield* getRunRecords(session, executionId).writeRunRecord(config());

        expect(yield* controller.buildExportInput(executionId)).toEqual({
          status: 'conversation_missing',
        });
      }),
  );
});
