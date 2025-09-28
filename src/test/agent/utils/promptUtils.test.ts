// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent
import { writePromptToXml } from '@agent/utils/promptUtils';

// Local imports - storage
import { StorageFS, TASK_RUNS_DIR, WorkspaceFS } from '@utils/files';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

describe('promptUtils.writePromptToXml', () => {
  type StorageFsMutable = {
    write: typeof StorageFS.write;
    ensureDir: typeof StorageFS.ensureDir;
    fullPath: typeof StorageFS.fullPath;
  };

  type WorkspaceFsMutable = {
    write: typeof WorkspaceFS.write;
    fullPath: typeof WorkspaceFS.fullPath;
  };

  const storageFs = StorageFS as unknown as StorageFsMutable;
  const workspaceFs = WorkspaceFS as unknown as WorkspaceFsMutable;

  const originalStorageWrite = storageFs.write;
  const originalStorageEnsureDir = storageFs.ensureDir;
  const originalStorageFullPath = storageFs.fullPath;
  const originalWorkspaceWrite = workspaceFs.write;
  const originalWorkspaceFullPath = workspaceFs.fullPath;

  let writes: {
    relativePath: string;
    content: string | Uint8Array<ArrayBufferLike>;
  }[];
  let ensured: string[];
  let workspaceWrites: {
    relativePath: string;
    content: string | Uint8Array<ArrayBufferLike>;
  }[];

  beforeEach(() => {
    writes = [];
    ensured = [];
    workspaceWrites = [];

    storageFs.write = async (relativePath, content) => {
      writes.push({ relativePath, content });
    };

    storageFs.ensureDir = async (relativePath) => {
      ensured.push(relativePath);
    };

    storageFs.fullPath = (relativePath) =>
      path.join('/mock/storage', relativePath);

    workspaceFs.write = async (relativePath, content) => {
      workspaceWrites.push({ relativePath, content });
    };

    workspaceFs.fullPath = (relativePath) =>
      path.join('/mock/workspace', relativePath);
  });

  afterEach(() => {
    storageFs.write = originalStorageWrite;
    storageFs.ensureDir = originalStorageEnsureDir;
    storageFs.fullPath = originalStorageFullPath;
    workspaceFs.write = originalWorkspaceWrite;
    workspaceFs.fullPath = originalWorkspaceFullPath;
  });

  it('writes prompts under the task run storage directory when executionId is provided', async () => {
    const executionId = 'run-123' as ExecutionId;

    const result = await writePromptToXml(
      'system message',
      'prefix',
      'request',
      '/tmp/input.tex',
      'write-agent',
      executionId,
    );

    assert.equal(writes.length, 1);
    assert.deepEqual(ensured, [TASK_RUNS_DIR, path.join(TASK_RUNS_DIR, executionId)]);

    const expectedRelative = path.join(
      TASK_RUNS_DIR,
      executionId,
      'input_agent_input.xml',
    );
    assert.equal(writes[0].relativePath, expectedRelative);
    assert.equal(result, path.join('/mock/storage', expectedRelative));
    assert.equal(typeof writes[0].content, 'string');
    if (typeof writes[0].content === 'string') {
      assert.ok(
        writes[0].content.includes('<system>system message</system>'),
        'Prompt content should include the system message',
      );
    }

    assert.equal(workspaceWrites.length, 0);
  });

  it('writes prompts under the workspace when executionId is absent', async () => {
    const result = await writePromptToXml(
      'system message',
      'prefix',
      'request',
      'docs/input.tex',
      'write-agent',
    );

    assert.equal(writes.length, 0);
    assert.deepEqual(ensured, []);
    assert.equal(workspaceWrites.length, 1);

    const expectedRelative = path.join('docs', 'input_agent_input.xml');
    assert.equal(workspaceWrites[0].relativePath, expectedRelative);
    assert.equal(result, path.join('/mock/workspace', expectedRelative));
  });
});
