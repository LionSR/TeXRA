// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import { ToolState } from '@agent/core/ToolState';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import { ToolUseSnapshotStore } from '@agent/toolUse/ToolUseSnapshotStore';

// Local imports - utilities
import { StorageFS } from '@utils/files';
import * as config from '@utils/config';

describe('ToolUseSnapshotStore', () => {
  type StorageFsMutable = {
    ensureDir: typeof StorageFS.ensureDir;
    writeJson: typeof StorageFS.writeJson;
    readJson: typeof StorageFS.readJson;
    readDir: typeof StorageFS.readDir;
    delete: typeof StorageFS.delete;
    cleanupOldFiles: typeof StorageFS.cleanupOldFiles;
  };

  type ConfigMutable = {
    getToolUsePersistenceEnabled: typeof config.getToolUsePersistenceEnabled;
    getToolUsePersistenceTtlHours: typeof config.getToolUsePersistenceTtlHours;
  };

  const storageFs = StorageFS as unknown as StorageFsMutable;
  const configModule = config as unknown as ConfigMutable;

  const originalEnsureDir = storageFs.ensureDir;
  const originalWriteJson = storageFs.writeJson;
  const originalReadJson = storageFs.readJson;
  const originalReadDir = storageFs.readDir;
  const originalDelete = storageFs.delete;
  const originalCleanupOldFiles = storageFs.cleanupOldFiles;
  const originalGetEnabled = configModule.getToolUsePersistenceEnabled;
  const originalGetTtl = configModule.getToolUsePersistenceTtlHours;

  let ensureDirCalls: string[];
  let writeJsonCalls: { relativePath: string; value: unknown }[];
  let readJsonResponses: Map<string, unknown>;
  let readDirEntries: [string, vscode.FileType][];
  let cleanupCalls: { dir: string; ttl: number }[];

  const executionId = 'run-1' as ExecutionId;
  const streamId = 'stream-1' as StreamTabId;

  function buildPayload() {
    const toolState = new ToolState();
    toolState.updateLastResponse('last');
    toolState.updateAccumulatedOutput('all');
    toolState.addMediaFiles(['media.png']);

    return {
      executionId,
      streamId,
      agentName: 'demo-agent',
      model: 'demo-model',
      session: {
        agentType: AgentType.ToolUse,
        agentCategory: AgentCategory.ToolUse,
      },
      messages: [],
      toolState,
    } satisfies Parameters<typeof ToolUseSnapshotStore.save>[0];
  }

  function buildSnapshot() {
    return {
      version: 1,
      executionId,
      streamId,
      agentName: 'demo-agent',
      model: 'demo-model',
      session: {
        agentType: AgentType.ToolUse,
        agentCategory: AgentCategory.ToolUse,
      },
      messages: [],
      toolState: {
        document: { texcountStats: null, mediaFiles: ['media.png'] },
        draft: { lastResponse: 'last', accumulatedOutput: 'all' },
        reasoning: { thinkingBlocks: [], thinkingAdded: false },
      },
      lastUpdated: Date.now(),
    };
  }

  beforeEach(() => {
    ensureDirCalls = [];
    writeJsonCalls = [];
    readJsonResponses = new Map();
    readDirEntries = [];
    cleanupCalls = [];

    configModule.getToolUsePersistenceEnabled = () => true;
    configModule.getToolUsePersistenceTtlHours = () => 36;

    storageFs.ensureDir = async (relativePath: string) => {
      ensureDirCalls.push(relativePath);
    };

    storageFs.writeJson = async (
      relativePath: string,
      value: unknown,
    ): Promise<void> => {
      writeJsonCalls.push({ relativePath, value });
    };

    storageFs.readJson = async (relativePath: string): Promise<any> => {
      if (!readJsonResponses.has(relativePath)) {
        throw new Error(`Missing mock for ${relativePath}`);
      }
      return readJsonResponses.get(relativePath);
    };

    storageFs.readDir = async (): Promise<[string, vscode.FileType][]> => {
      return readDirEntries;
    };

    storageFs.delete = async (): Promise<void> => {
      /* no-op for tests */
    };

    storageFs.cleanupOldFiles = async (dir: string, ttl: number) => {
      cleanupCalls.push({ dir, ttl });
    };
  });

  afterEach(() => {
    storageFs.ensureDir = originalEnsureDir;
    storageFs.writeJson = originalWriteJson;
    storageFs.readJson = originalReadJson;
    storageFs.readDir = originalReadDir;
    storageFs.delete = originalDelete;
    storageFs.cleanupOldFiles = originalCleanupOldFiles;
    configModule.getToolUsePersistenceEnabled = originalGetEnabled;
    configModule.getToolUsePersistenceTtlHours = originalGetTtl;
  });

  it('save writes normalized snapshot to storage', async () => {
    const payload = buildPayload();

    await ToolUseSnapshotStore.save(payload);

    assert.deepEqual(ensureDirCalls, ['toolUseSessions']);
    assert.equal(writeJsonCalls.length, 1);

    const { relativePath, value } = writeJsonCalls[0];
    assert.equal(
      relativePath,
      path.join('toolUseSessions', `${executionId}.json`),
    );
    const stored = value as ReturnType<typeof buildSnapshot>;
    assert.equal(stored.session.agentType, AgentType.ToolUse);
    assert.notStrictEqual(stored.messages, payload.messages);
    assert.equal(stored.toolState.draft.lastResponse, 'last');
  });

  it('list triggers TTL cleanup and filters invalid snapshots', async () => {
    readDirEntries = [
      ['run-1.json', vscode.FileType.File],
      ['invalid.json', vscode.FileType.File],
      ['ignore', vscode.FileType.Directory],
    ];

    const validPath = path.join('toolUseSessions', 'run-1.json');
    const invalidPath = path.join('toolUseSessions', 'invalid.json');

    readJsonResponses.set(validPath, buildSnapshot());
    readJsonResponses.set(invalidPath, { version: 1 });

    const snapshots = await ToolUseSnapshotStore.list();

    assert.equal(cleanupCalls.length, 1);
    assert.equal(cleanupCalls[0].dir, 'toolUseSessions');
    const expectedTtlMs = 36 * 60 * 60 * 1000;
    assert.equal(cleanupCalls[0].ttl, expectedTtlMs);

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].executionId, executionId);
  });

  it('load returns null when persistence disabled', async () => {
    configModule.getToolUsePersistenceEnabled = () => false;

    const result = await ToolUseSnapshotStore.load(executionId);

    assert.equal(result, null);
    assert.equal(ensureDirCalls.length, 0);
  });
});
