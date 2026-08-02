// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, beforeEach, afterEach, vi } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { TextEditorTool } from '@tools/TextEditorTool';
import { cleanupAllApprovals } from '@tools/approval';
import { WorkspaceFS } from '@utils/files';

const EXECUTION_ID = 'history-cap-exec';

let detachHostInteractions = (): void => {};

async function installPlatform(
  files: Record<string, string | Uint8Array> = {},
) {
  await installFakePlatform({ workspacePath: '/workspace', files });
  detachHostInteractions();
  detachHostInteractions = defaultSession().useHostInteractions({
    requestToolEditApproval: async (request) => ({
      accepted: true,
      appliedContent: request.proposedContent,
    }),
    cancel: () => undefined,
  });
}

async function callTextEditor(
  tool: TextEditorTool,
  input: unknown,
  options: { executionId?: string; session?: SessionHandle } = {},
) {
  const executionId = options.executionId ?? EXECUTION_ID;
  return withRunContext(
    createRunContext({
      streamId: `stream:${executionId}` as StreamTabId,
      executionId,
      session: options.session,
    }),
    () => tool.call(input),
  );
}

interface TextEditorToolInternals {
  fileHistory: {
    hasExecution(executionId: string): boolean;
    filesFor(
      executionId: string,
    ): ReadonlyMap<string, readonly string[]> | undefined;
  };
}

describe('TextEditorTool undo history lifecycle', () => {
  beforeEach(async () => {
    await installPlatform();
    cleanupAllApprovals();
  });

  afterEach(() => {
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
    const history = [
      ...(internals.fileHistory.filesFor(EXECUTION_ID)?.values() ?? []),
    ].at(0);
    assert.ok(history, 'expected an undo-history entry for loop.tex');
    assert.ok(
      history.length <= 50,
      `expected history capped at 50, got ${history.length}`,
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

  it('releases all snapshots when the owning execution completes', async () => {
    await installPlatform({ '/workspace/lifecycle.tex': 'before\n' });
    const tool = new TextEditorTool();
    const session = defaultSession();
    const streamId = `stream:${EXECUTION_ID}` as StreamTabId;
    const handle = testExecutionHandle({
      executionId: EXECUTION_ID,
      parentStreamId: streamId,
      agent: 'orchestrator',
    });
    session.executions.track(handle);

    try {
      const result = await callTextEditor(
        tool,
        {
          command: 'str_replace',
          path: 'lifecycle.tex',
          old_str: 'before',
          new_str: 'after',
        },
        { session },
      );
      assert.strictEqual(result.status, 'executed');

      const internals = tool as unknown as TextEditorToolInternals;
      assert.strictEqual(
        [...(internals.fileHistory.filesFor(EXECUTION_ID)?.values() ?? [])].at(
          0,
        )?.length,
        1,
      );

      session.executions.untrack(EXECUTION_ID);
      assert.strictEqual(
        internals.fileHistory.hasExecution(EXECUTION_ID),
        false,
      );
    } finally {
      session.executions.untrack(EXECUTION_ID);
    }
  });

  it('registers one completion listener per execution even after undo empties its history', async () => {
    await installPlatform({ '/workspace/relisten.tex': 'one\n' });
    const tool = new TextEditorTool();
    const session = defaultSession();
    const streamId = `stream:${EXECUTION_ID}` as StreamTabId;
    const handle = testExecutionHandle({
      executionId: EXECUTION_ID,
      parentStreamId: streamId,
      agent: 'orchestrator',
    });
    session.executions.track(handle);
    const addListener = vi.spyOn(session.executions, 'addListener');

    try {
      const firstEdit = await callTextEditor(
        tool,
        {
          command: 'str_replace',
          path: 'relisten.tex',
          old_str: 'one',
          new_str: 'two',
        },
        { session },
      );
      assert.strictEqual(firstEdit.status, 'executed');

      // Undo pops the only snapshot for the only edited file, leaving the
      // execution with an empty snapshot set.
      const undo = await callTextEditor(
        tool,
        { command: 'undo_edit', path: 'relisten.tex' },
        { session },
      );
      assert.strictEqual(undo.status, 'executed');

      const secondEdit = await callTextEditor(
        tool,
        {
          command: 'str_replace',
          path: 'relisten.tex',
          old_str: 'one',
          new_str: 'three',
        },
        { session },
      );
      assert.strictEqual(secondEdit.status, 'executed');

      assert.strictEqual(
        addListener.mock.calls.filter((call) => call[0] === EXECUTION_ID)
          .length,
        1,
      );
    } finally {
      addListener.mockRestore();
      session.executions.untrack(EXECUTION_ID);
    }
  });

  it('keeps undo history isolated between execution ids', async () => {
    await installPlatform({ '/workspace/shared.tex': 'alpha\n' });
    const tool = new TextEditorTool();

    const parentEdit = await callTextEditor(
      tool,
      {
        command: 'str_replace',
        path: 'shared.tex',
        old_str: 'alpha',
        new_str: 'parent',
      },
      { executionId: 'aaaaaa' },
    );
    assert.strictEqual(parentEdit.status, 'executed');
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'parent\n');

    const childEdit = await callTextEditor(
      tool,
      {
        command: 'str_replace',
        path: 'shared.tex',
        old_str: 'parent',
        new_str: 'child',
      },
      { executionId: 'bbbbbb' },
    );
    assert.strictEqual(childEdit.status, 'executed');
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'child\n');

    const parentUndo = await callTextEditor(
      tool,
      { command: 'undo_edit', path: 'shared.tex' },
      { executionId: 'aaaaaa' },
    );
    assert.strictEqual(parentUndo.status, 'executed');
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'alpha\n');

    const childUndo = await callTextEditor(
      tool,
      { command: 'undo_edit', path: 'shared.tex' },
      { executionId: 'bbbbbb' },
    );
    assert.strictEqual(childUndo.status, 'executed');
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'parent\n');
  });
});
