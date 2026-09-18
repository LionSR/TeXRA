import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { beforeEach, describe, expect } from 'vitest';

import { getRunRecords } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

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
    {
      workspacePath: workspaceDir,
      storagePath: storage.getStoragePath(),
      globalStoragePath: storage.getGlobalStoragePath(),
    },
    {
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

const persistTranscriptEntry = (runId: RunId) =>
  session.commit([
    {
      type: 'log',
      aggregateId: aggregateId('run', runId),
      level: LOG_LEVELS.INFO,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      message: 'hello',
    },
  ]);

/** The session's settle, run by each test that waits on its publications. */
const settlePublications = Effect.suspend(() => session.settlePublications());

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

  it.effect('returns config_missing when nothing is stored', () =>
    Effect.gen(function* () {
      const templatePath = yield* Effect.promise(writeTemplate);

      const outcome = yield* controller.exportAsHtml(
        'eec404' as RunId,
        templatePath,
      );

      expect(outcome).toEqual({ status: 'config_missing' });
    }).pipe(Effect.provide(rootedFsLayer(session.roots))),
  );

  it.effect(
    'writes a self-contained HTML file with the trace embedded, when everything is present',
    () =>
      Effect.gen(function* () {
        const templatePath = yield* Effect.promise(writeTemplate);
        const runId = 'eec001' as RunId;
        const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });
        publishTestRunStart(session, runId);
        yield* settlePublications;
        yield* getRunRecords(session, runId).writeRunRecord(runConfigRecord);
        yield* persistTranscriptEntry(runId);

        const outcome = yield* controller.exportAsHtml(runId, templatePath);

        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;
        expect(outcome.result.storagePath).toMatch(
          /^executions\/eec001\/texra-chat-.*\.html$/,
        );

        const html = yield* Effect.promise(() =>
          readFile(outcome.result.absolutePath, 'utf-8'),
        );
        expect(html).toContain('<script>window.__TEXRA_TRACE__');
        expect(html).toContain('"message":"hello"');
        expect(html).toContain(
          '<script type="module" crossorigin src="./index.js">',
        );
      }).pipe(Effect.provide(rootedFsLayer(session.roots))),
  );

  it.effect('throws when the standalone template bundle is missing', () =>
    Effect.gen(function* () {
      const runId = 'eec002' as RunId;
      publishTestRunStart(session, runId);
      yield* settlePublications;
      yield* getRunRecords(session, runId).writeRunRecord(config());
      yield* persistTranscriptEntry(runId);

      const error = yield* Effect.flip(
        controller.exportAsHtml(runId, '/nonexistent/index.html'),
      );
      expect(error.message).toMatch(/Trace-viewer standalone bundle missing/);
    }).pipe(Effect.provide(rootedFsLayer(session.roots))),
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

  it.effect('reports config_missing when nothing is stored', () =>
    Effect.gen(function* () {
      expect(yield* controller.buildExportInput('eec404' as RunId)).toEqual({
        status: 'config_missing',
      });
    }),
  );

  it.effect('returns ok when config and transcript are stored', () =>
    Effect.gen(function* () {
      const runId = 'eec001' as RunId;
      publishTestRunStart(session, runId);
      yield* settlePublications;
      yield* getRunRecords(session, runId).writeRunRecord(config());
      yield* persistTranscriptEntry(runId);

      expect(yield* controller.buildExportInput(runId)).toMatchObject({
        status: 'ok',
      });
    }),
  );

  it.effect(
    'reports conversation_missing when a config is stored but no transcript exists',
    () =>
      Effect.gen(function* () {
        const runId = 'eec003' as RunId;
        publishTestRunStart(session, runId);
        yield* settlePublications;
        yield* getRunRecords(session, runId).writeRunRecord(config());

        expect(yield* controller.buildExportInput(runId)).toEqual({
          status: 'conversation_missing',
        });
      }),
  );
});
