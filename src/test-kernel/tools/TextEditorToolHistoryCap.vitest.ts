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
import { WorkspaceFS } from '@utils/files/workspaceFS';

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

async function strReplace(
  tool: TextEditorTool,
  path: string,
  oldStr: string,
  newStr: string,
  options: { executionId?: string; session?: SessionHandle } = {},
): Promise<void> {
  const result = await callTextEditor(
    tool,
    { command: 'str_replace', path, old_str: oldStr, new_str: newStr },
    options,
  );
  assert.strictEqual(result.status, 'executed');
}

async function undoEdit(
  tool: TextEditorTool,
  path: string,
  options: { executionId?: string; session?: SessionHandle } = {},
): Promise<void> {
  const result = await callTextEditor(
    tool,
    { command: 'undo_edit', path },
    options,
  );
  assert.strictEqual(result.status, 'executed');
}

function trackOrchestratorExecution(session: SessionHandle): void {
  session.executions.track(
    testExecutionHandle({
      executionId: EXECUTION_ID,
      parentStreamId: `stream:${EXECUTION_ID}` as StreamTabId,
      agent: 'orchestrator',
    }),
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

function historyOf(
  tool: TextEditorTool,
): TextEditorToolInternals['fileHistory'] {
  return (tool as unknown as TextEditorToolInternals).fileHistory;
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
      await strReplace(tool, 'loop.tex', `${n}`, `${n + 1}`);
    }
    assert.strictEqual(await WorkspaceFS.read('loop.tex'), `${EDIT_COUNT}\n`);

    const history = [
      ...(historyOf(tool).filesFor(EXECUTION_ID)?.values() ?? []),
    ].at(0);
    assert.ok(history, 'expected an undo-history entry for loop.tex');
    assert.ok(
      history.length <= 50,
      `expected history capped at 50, got ${history.length}`,
    );

    // The cap must never affect the one documented behavior: undoing the
    // most recently applied edit.
    await undoEdit(tool, 'loop.tex');
    assert.strictEqual(
      await WorkspaceFS.read('loop.tex'),
      `${EDIT_COUNT - 1}\n`,
    );
  });

  it('releases all snapshots when the owning execution completes', async () => {
    await installPlatform({ '/workspace/lifecycle.tex': 'before\n' });
    const tool = new TextEditorTool();
    const session = defaultSession();
    trackOrchestratorExecution(session);

    try {
      await strReplace(tool, 'lifecycle.tex', 'before', 'after', { session });

      assert.strictEqual(
        [...(historyOf(tool).filesFor(EXECUTION_ID)?.values() ?? [])].at(0)
          ?.length,
        1,
      );

      session.executions.untrack(EXECUTION_ID);
      assert.strictEqual(historyOf(tool).hasExecution(EXECUTION_ID), false);
    } finally {
      session.executions.untrack(EXECUTION_ID);
    }
  });

  it('registers one completion listener per execution even after undo empties its history', async () => {
    await installPlatform({ '/workspace/relisten.tex': 'one\n' });
    const tool = new TextEditorTool();
    const session = defaultSession();
    trackOrchestratorExecution(session);
    const addListener = vi.spyOn(session.executions, 'addListener');

    try {
      await strReplace(tool, 'relisten.tex', 'one', 'two', { session });

      // Undo pops the only snapshot for the only edited file, leaving the
      // execution with an empty snapshot set.
      await undoEdit(tool, 'relisten.tex', { session });

      await strReplace(tool, 'relisten.tex', 'one', 'three', { session });

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

    await strReplace(tool, 'shared.tex', 'alpha', 'parent', {
      executionId: 'aaaaaa',
    });
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'parent\n');

    await strReplace(tool, 'shared.tex', 'parent', 'child', {
      executionId: 'bbbbbb',
    });
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'child\n');

    await undoEdit(tool, 'shared.tex', { executionId: 'aaaaaa' });
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'alpha\n');

    await undoEdit(tool, 'shared.tex', { executionId: 'bbbbbb' });
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'parent\n');
  });
});
