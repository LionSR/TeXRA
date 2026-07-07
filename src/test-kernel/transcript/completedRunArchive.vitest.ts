/**
 * Completed-run archive facade (#7246 Decision 1): the transcript sidecars
 * own completed-run display/export, with `executions/{id}/conversation.json`
 * / `todos.json` as read-only legacy fallbacks.
 *
 * Cross-module scenario (stated in the PR body): the fixture below builds a
 * real completed execution on disk with ONLY sidecar data — no
 * `conversation.json` / `todos.json` projections, matching what tool-use
 * runs persist now that the per-step projection writes are deleted — and
 * proves conversation display, chat export, and todos all read through the
 * facade.
 */
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  readCompletedRunConversation,
  readCompletedRunTodos,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import { loadChatExportInput } from '@agent/export/loadChatExportInput';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import type { Platform } from '@platform/platform';

const tempDirs: string[] = [];

async function buildArchivePlatform(): Promise<Platform> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-archive-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return createFakePlatform(
    { workspacePath: workspaceDir },
    {
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspaceDir),
      storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );
}

function taskState(agent: string, model = 'deepseekproT'): TaskState {
  return TaskStateSchema.parse({
    agentConfig: { agent, model, agentCategory: AgentCategory.ToolUse },
  });
}

let entryCounter = 0;

function logRow(
  messageType: string,
  fields: { text?: string; data?: unknown },
): Parameters<StreamLogStore['append']>[1] {
  entryCounter += 1;
  return {
    id: `entry-${entryCounter}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 1000 + entryCounter,
    messageType: messageType as never,
    ...fields,
  };
}

/** Write the sidecar fixture: transcript rows + snapshot meta/todos. */
async function writeSidecarFixture(
  executionId: ExecutionId,
  streamId: StreamTabId,
): Promise<void> {
  const snapshots = new StreamSnapshotStore();
  snapshots.setTaskState(streamId, taskState('orchestrator'), executionId);
  snapshots.setTodos(streamId, [
    { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
  ]);
  await snapshots.flush();

  const logs = new StreamLogStore();
  await logs.load();
  logs.ensureStream(streamId);
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Fix the lemma.',
    }),
  );
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.TOOL_USE, {
      data: {
        toolName: 'write_file',
        input: { path: 'notes/lemma.tex' },
        output: 'File written.',
        status: 'completed',
      },
    }),
  );
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Done - the lemma is fixed.',
    }),
  );
  await logs.flush();
}

/** Locate a file under `dir` by name (recursive), for mtime manipulation. */
async function findFile(dir: string, name: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const match = entries.find((entry) => entry.isFile() && entry.name === name);
  if (!match) throw new Error(`Fixture file not found: ${name}`);
  return path.join(match.parentPath, match.name);
}

async function setMtime(filePath: string, epochMs: number): Promise<void> {
  await utimes(filePath, new Date(epochMs), new Date(epochMs));
}

describe('completedRunArchive facade', () => {
  setupPlatform(buildArchivePlatform);

  beforeEach(() => {
    clearStoreCache();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('serves conversation, chat export, and todos from the sidecars alone (projections gone)', async () => {
    const executionId = 'abc123abc123' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc123abc123' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);

    const store = getExecutionStore(executionId);
    await store.writeConfig(
      AgentConfigSchema.parse({
        agent: 'orchestrator',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Fix the lemma.',
      }),
    );
    await store.writeMeta({
      timestamp: '2026-07-07T00:00:00.000Z',
      terminalStatus: 'completed',
    });

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult.source).toBe('streamLog');
    expect(conversationResult.streamId).toBe(streamId);
    expect(conversationResult.conversation).toEqual([
      { role: 'user', content: 'Fix the lemma.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'write_file',
            input: { path: 'notes/lemma.tex' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'File written.' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done - the lemma is fixed.' }],
      },
    ]);

    // Chat export assembles from the same facade read — no conversation.json.
    const exportResult = await loadChatExportInput(executionId);
    expect(exportResult.exportInput).not.toBeNull();
    expect(exportResult.exportInput?.messages).toEqual(
      conversationResult.conversation,
    );

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult.source).toBe('streamData');
    expect(todosResult.todos).toEqual([
      { content: 'Fix the bug', status: 'completed' },
    ]);
  });

  it('falls back to the legacy KV projections when no sidecar exists', async () => {
    const executionId = 'bbb222bbb222' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.writeConversation([
      { role: 'user', content: 'Legacy question' },
      { role: 'assistant', content: 'Legacy answer' },
    ]);
    await store.writeTodos([{ content: 'Legacy todo', status: 'pending' }]);

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult.source).toBe('legacyKV');
    expect(conversationResult.conversation).toEqual([
      { role: 'user', content: 'Legacy question' },
      { role: 'assistant', content: 'Legacy answer' },
    ]);

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult.source).toBe('legacyKV');
    expect(todosResult.todos).toEqual([
      { content: 'Legacy todo', status: 'pending' },
    ]);
  });

  it('reports none when neither the sidecar nor the legacy projection has data', async () => {
    const executionId = 'ccc333ccc333' as ExecutionId;

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult).toEqual({ todos: [], source: 'none' });
  });

  it('prefers a demonstrably fresher legacy conversation write over the sidecar', async () => {
    const executionId = 'ddd444ddd444' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#ddd444ddd444' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);
    await getExecutionStore(executionId).writeConversation([
      { role: 'assistant', content: 'Fresher legacy write' },
    ]);

    const storageDir = tempDirs.at(-1)!;
    const legacyPath = await findFile(storageDir, 'conversation.json');
    const sidecarPath = await findFile(
      path.dirname(await findFile(storageDir, 'workPlan.json')),
      'meta.json',
    );
    // streamLogs/{stream}.json lives beside the streamData dir; find it by
    // its encoded name under the streamLogs directory.
    const streamLogsDir = path.join(
      path.dirname(path.dirname(path.dirname(sidecarPath))),
      'streamLogs',
    );
    const [streamLogFile] = await readdir(streamLogsDir);
    const streamLogPath = path.join(streamLogsDir, streamLogFile);

    // Legacy write is strictly fresher than the sidecar -> legacy wins.
    await setMtime(streamLogPath, Date.now() - 60_000);
    await setMtime(legacyPath, Date.now());

    const fresher = await readCompletedRunConversation(executionId);
    expect(fresher.source).toBe('legacyKV');
    expect(fresher.conversation).toEqual([
      { role: 'assistant', content: 'Fresher legacy write' },
    ]);

    // Sidecar strictly fresher -> sidecar wins.
    await setMtime(legacyPath, Date.now() - 120_000);
    await setMtime(streamLogPath, Date.now());
    const sidecarWins = await readCompletedRunConversation(executionId);
    expect(sidecarWins.source).toBe('streamLog');
  });

  it('falls back to legacy when the transcript holds no conversation-shaped rows', async () => {
    const executionId = 'eee555eee555' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#eee555eee555' as StreamTabId;

    const snapshots = new StreamSnapshotStore();
    snapshots.setTaskState(streamId, taskState('orchestrator'), executionId);
    await snapshots.flush();

    const logs = new StreamLogStore();
    await logs.load();
    logs.ensureStream(streamId);
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Working...' }),
    );
    await logs.flush();

    await getExecutionStore(executionId).writeConversation([
      { role: 'user', content: 'Pre-sidecar conversation' },
    ]);
    // The sidecar exists and is fresher, but reconstructs to zero messages —
    // the facade must not report an empty conversation over real legacy data.
    const legacyPath = await findFile(tempDirs.at(-1)!, 'conversation.json');
    await setMtime(legacyPath, Date.now() - 60_000);

    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('legacyKV');
    expect(result.conversation).toEqual([
      { role: 'user', content: 'Pre-sidecar conversation' },
    ]);
  });
});
