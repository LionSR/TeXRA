// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, beforeEach, afterEach } from 'vitest';

// Local imports
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { TextEditorTool } from '@tools/TextEditorTool';
import {
  cleanupAllApprovals,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval';
import { WorkspaceFS } from '@utils/files';

const EXECUTION_ID = 'history-cap-exec';

let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let detachHostInteractions = (): void => {};

async function installPlatform(
  files: Record<string, string | Uint8Array> = {},
) {
  testApprovalHandler = async () => ({ accepted: true });
  await installFakePlatform({ workspacePath: '/workspace', files });
  detachHostInteractions();
  detachHostInteractions = defaultSession().useHostInteractions({
    requestToolEditApproval: (request) => {
      const handler = testApprovalHandler;
      if (!handler) {
        throw new Error('No test approval handler configured.');
      }
      return handler(request);
    },
    cancel: () => undefined,
  });
}

async function callTextEditor(tool: TextEditorTool, input: unknown) {
  return withRunContext(
    createRunContext({
      runtimeHost: noopAgentRuntimeHost,
      streamId: `stream:${EXECUTION_ID}` as StreamTabId,
      executionId: EXECUTION_ID,
    }),
    () => tool.call(input),
  );
}

interface TextEditorToolInternals {
  fileHistory: Map<string, string[]>;
}

describe('TextEditorTool undo history cap', () => {
  beforeEach(async () => {
    await installPlatform();
    cleanupAllApprovals();
  });

  afterEach(() => {
    testApprovalHandler = undefined;
    detachHostInteractions();
    detachHostInteractions = () => {};
    cleanupAllApprovals();
  });

  it('bounds retained snapshots per file without breaking the most recent undo', async () => {
    await installPlatform({ '/workspace/loop.tex': '0\n' });
    const tool = new TextEditorTool();

    const EDIT_COUNT = 60; // comfortably past MAX_HISTORY_PER_FILE (50)
    for (let n = 0; n < EDIT_COUNT; n += 1) {
      const result = await callTextEditor(tool, {
        command: 'str_replace',
        path: 'loop.tex',
        old_str: `${n}`,
        new_str: `${n + 1}`,
      });
      assert.strictEqual(result.status, 'executed');
    }
    assert.strictEqual(await WorkspaceFS.read('loop.tex'), `${EDIT_COUNT}\n`);

    const internals = tool as unknown as TextEditorToolInternals;
    const key = [...internals.fileHistory.keys()].find((k) =>
      k.endsWith('loop.tex'),
    );
    assert.ok(key, 'expected an undo-history entry for loop.tex');
    assert.ok(
      internals.fileHistory.get(key!)!.length <= 50,
      `expected history capped at 50, got ${internals.fileHistory.get(key!)!.length}`,
    );

    // The cap must never affect the one documented behavior: undoing the
    // most recently applied edit.
    const undo = await callTextEditor(tool, {
      command: 'undo_edit',
      path: 'loop.tex',
    });
    assert.strictEqual(undo.status, 'executed');
    assert.strictEqual(
      await WorkspaceFS.read('loop.tex'),
      `${EDIT_COUNT - 1}\n`,
    );
  });
});
