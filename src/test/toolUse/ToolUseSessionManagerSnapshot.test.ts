import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import * as vscode from 'vscode';

import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import { ToolState } from '@agent/core/ToolState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import StorageFS from '@utils/files/storageFS';

const STORAGE_DIR = path.join(os.tmpdir(), 'texra-tooluse-snapshot-tests');

function createContext(): vscode.ExtensionContext {
  const uri = vscode.Uri.file(STORAGE_DIR);
  return {
    storageUri: uri,
    globalStorageUri: uri,
  } as unknown as vscode.ExtensionContext;
}

async function resetStorageDir(): Promise<void> {
  await fs
    .rm(STORAGE_DIR, { recursive: true, force: true })
    .catch(() => undefined);
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

suite('ToolUseSessionManager snapshot compatibility', () => {
  suiteSetup(async () => {
    await resetStorageDir();
    StorageFS.initialize(createContext());
  });

  setup(async () => {
    await fs
      .rm(path.join(STORAGE_DIR, 'toolUseSessions'), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
  });

  suiteTeardown(async () => {
    await resetStorageDir();
  });

  function buildPayload(executionId: ExecutionId) {
    const toolState = new ToolState();
    toolState.updateLastResponse('response');
    toolState.updateAccumulatedOutput('response');

    return {
      executionId,
      streamId: 'stream-id',
      agentName: 'demo-agent',
      model: 'demo-model',
      session: { agentType: AgentType.ToolUse, agentCategory: AgentCategory.ToolUse },
      messages: [] as ProviderMessage[],
      toolState,
    };
  }

  function buildLegacySnapshot(executionId: ExecutionId) {
    return {
      version: 1,
      executionId,
      streamId: 'stream-id',
      agentName: 'demo-agent',
      model: 'demo-model',
      agentSessionKind: AgentCategory.ToolUse,
      messages: [],
      toolState: {
        texcountStats: null,
        lastResponse: 'response',
        accumulatedOutput: 'response',
        mediaFiles: [],
        thinkingBlocks: [],
        thinkingAdded: false,
      },
      lastUpdated: Date.now(),
    };
  }

  test('saveSnapshot and loadSnapshot round trip', async () => {
    const executionId = 'round-trip' as ExecutionId;
    const payload = buildPayload(executionId);

    await ToolUseSessionManager.saveSnapshot(payload);
    const loaded = await ToolUseSessionManager.loadSnapshot(executionId);

    assert.ok(loaded, 'expected snapshot to be returned');
    assert.strictEqual(loaded?.executionId, executionId);
    assert.strictEqual(loaded?.toolState.lastResponse, 'response');
  });

  test('loadSnapshot reads snapshots saved before helper migration', async () => {
    const executionId = 'legacy-snapshot' as ExecutionId;
    const snapshot = buildLegacySnapshot(executionId);

    await StorageFS.ensureDir('toolUseSessions');
    await StorageFS.write(
      path.join('toolUseSessions', `${executionId}.json`),
      JSON.stringify(snapshot, null, 2),
    );

    const loaded = await ToolUseSessionManager.loadSnapshot(executionId);

    assert.ok(loaded, 'expected legacy snapshot to load');
    assert.strictEqual(loaded?.executionId, executionId);
  });

  test('loadSnapshot falls back to raw JSON parsing when helper fails', async () => {
    const executionId = 'fallback-snapshot' as ExecutionId;
    const snapshot = buildLegacySnapshot(executionId);

    await StorageFS.ensureDir('toolUseSessions');
    await StorageFS.write(
      path.join('toolUseSessions', `${executionId}.json`),
      JSON.stringify(snapshot, null, 2),
    );

    const originalReadJson = StorageFS.readJson;

    (
      StorageFS as typeof StorageFS & {
        readJson: typeof StorageFS.readJson;
      }
    ).readJson = async () => {
      throw new SyntaxError('forced failure');
    };

    try {
      const loaded = await ToolUseSessionManager.loadSnapshot(executionId);
      assert.ok(loaded, 'expected fallback parsing to succeed');
      assert.strictEqual(loaded?.executionId, executionId);
    } finally {
      (
        StorageFS as typeof StorageFS & {
          readJson: typeof StorageFS.readJson;
        }
      ).readJson = originalReadJson;
    }
  });
});
