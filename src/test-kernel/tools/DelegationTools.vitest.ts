// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryUseRunContext: vi.fn(),
  currentSession: vi.fn(),
  sendFollowUp: vi.fn(),
  wakeQueuedFollowUpStream: vi.fn(),
  isChildRunLoopActive: vi.fn(),
  deliverChildRunFollowUp: vi.fn(),
}));

vi.mock('@agent/runtime/RunContext', () => {
  const readRunContextField = (context: any, field: string) =>
    context?.kind === 'launch' ? context.runScope[field] : context?.[field];
  return {
    tryUseRunContext: mocks.tryUseRunContext,
    getRunContextStreamId: (context: any) =>
      readRunContextField(context, 'streamId'),
  };
});

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: mocks.sendFollowUp,
  wakeQueuedFollowUpStream: mocks.wakeQueuedFollowUpStream,
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  isChildRunLoopActive: mocks.isChildRunLoopActive,
}));

vi.mock('@tools/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

// Local imports
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { FollowUpWakeResult } from '@agent/followUp/ToolUseFollowUp';
import { FileType, type FileStat } from '@platform/interfaces';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import {
  DelegateAgentTool,
  rejectOversizedBibAttachments,
  type WorkflowAgentInput,
} from '@tools/DelegationTools';
import { WorkspaceFS } from '@utils/files';

const BASE_INPUT: WorkflowAgentInput = {
  agent: 'criticize',
  model: 'opus48T',
  instruction: 'Review the manuscript.',
  inputFiles: ['main.tex'],
  contextFiles: [],
  mediaFiles: [],
  extractFigures: null,
  extractTikz: null,
  outputFiles: [],
  memories: [],
};

function stat(size: number): FileStat {
  return {
    type: FileType.File,
    ctime: 0,
    mtime: 0,
    size,
  };
}

describe('DelegationTools', () => {
  const originalStat = WorkspaceFS.stat;

  afterEach(() => {
    WorkspaceFS.stat = originalStat;
  });

  it('rejects context .bib files larger than 100KB', async () => {
    WorkspaceFS.stat = async () => stat(100 * 1024 + 1);

    const result = await rejectOversizedBibAttachments(['references.bib']);

    assert.strictEqual(result?.status, 'error');
    assert.strictEqual(result?.summary, 'Rejected oversized BibTeX attachment');
    assert.strictEqual(
      result?.error,
      'references.bib is 102401 bytes (100 KiB), over the 102400 byte (100 KiB) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.',
    );
    assert.deepStrictEqual(result?.diagnostics, {
      type: 'oversized_bib_attachment',
      path: 'references.bib',
      sizeBytes: 102401,
      limitBytes: 102400,
    });
  });

  it('rejects context .bib files in the multi-list larger than 100KB', async () => {
    WorkspaceFS.stat = async () => stat(150 * 1024);

    const result = await rejectOversizedBibAttachments([
      'paper.tex',
      'bibliography/main.bib',
    ]);

    assert.strictEqual(result?.status, 'error');
    assert.deepStrictEqual(result?.diagnostics, {
      type: 'oversized_bib_attachment',
      path: 'bibliography/main.bib',
      sizeBytes: 153600,
      limitBytes: 102400,
    });
  });

  it('allows .bib files at the 100KB limit', async () => {
    WorkspaceFS.stat = async () => stat(100 * 1024);

    const result = await rejectOversizedBibAttachments(['library.bib']);

    assert.strictEqual(result, null);
  });

  it('ignores non-bib context files', async () => {
    let statCalled = false;
    WorkspaceFS.stat = async () => {
      statCalled = true;
      return stat(500 * 1024);
    };

    const result = await rejectOversizedBibAttachments([
      'paper.tex',
      'preamble.tex',
    ]);

    assert.strictEqual(result, null);
    assert.strictEqual(statCalled, false);
  });
});

// Races the tool call's promise against a short timer so a regression that
// re-introduces blocking (awaiting the resumed child's full turn) fails fast
// instead of hanging until the child eventually resolves.
async function raceAgainstBlockingResume<T>(
  promise: Promise<T>,
): Promise<{ settled: true; value: T } | { settled: false }> {
  const TIMEOUT = Symbol('timeout');
  const outcome = await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    new Promise<typeof TIMEOUT>((resolve) =>
      setTimeout(() => resolve(TIMEOUT), 50),
    ),
  ]);
  return outcome === TIMEOUT ? { settled: false } : outcome;
}

describe('DelegateAgentTool resume (issue #7289)', () => {
  const executionId = 'exec-resume-issue-7289';
  const parentStreamId = 'parent-stream' as StreamTabId;
  const childStreamId = 'child-stream' as StreamTabId;

  function makeHandle(): AgentExecutionHandle {
    return new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'review',
      AgentCategory.ToolUse,
      { emit: vi.fn() } as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryUseRunContext.mockReturnValue({
      streamId: parentStreamId,
    } as never);
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: () => makeHandle() },
    } as never);
    mocks.sendFollowUp.mockResolvedValue({
      status: 'queued',
      reason: 'waiting',
    });
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
  });

  it('does not dispatch a wake when a child-run loop is already listening on the resumed stream', async () => {
    // The loop is already blocked in queue.waitAndDrainAll on the same
    // FollowUpQueue instance sendFollowUp just enqueued into — the enqueue
    // alone resolves it, so a wake here would race a second, competing
    // resume through the generic host resume port (see childRunLoop.ts's
    // isChildRunLoopActive doc comment).
    mocks.isChildRunLoopActive.mockReturnValue(true);

    const tool = new DelegateAgentTool();
    const outcome = await raceAgainstBlockingResume(
      tool.call({ execution_id: executionId, instruction: 'Keep going.' }),
    );

    assert.strictEqual(
      outcome.settled,
      true,
      'delegate_agent resume blocked the parent tool call',
    );
    if (outcome.settled) {
      assert.strictEqual(outcome.value.status, 'executed');
    }
    assert.strictEqual(mocks.wakeQueuedFollowUpStream.mock.calls.length, 0);
  });

  it('returns once the follow-up is queued, without waiting for the host resume port when no loop is listening', async () => {
    mocks.isChildRunLoopActive.mockReturnValue(false);
    let resolveWake: ((value: FollowUpWakeResult) => void) | undefined;
    mocks.wakeQueuedFollowUpStream.mockReturnValue(
      new Promise<FollowUpWakeResult>((resolve) => {
        resolveWake = resolve;
      }),
    );

    const tool = new DelegateAgentTool();
    const outcome = await raceAgainstBlockingResume(
      tool.call({ execution_id: executionId, instruction: 'Keep going.' }),
    );

    assert.strictEqual(
      outcome.settled,
      true,
      'delegate_agent resume blocked the parent tool call on the host resume port',
    );
    if (outcome.settled) {
      assert.strictEqual(outcome.value.status, 'executed');
    }
    assert.strictEqual(mocks.wakeQueuedFollowUpStream.mock.calls.length, 1);

    resolveWake?.({ kind: 'resumed' });
  });

  it('delivers a terminal error to the parent when the wake resolves as failed (no thrown exception)', async () => {
    // Regression: the removed NativeSubagentStrategy delivered a terminal
    // error to the orchestrator on this exact wake failure. Without it, this
    // tool call returns a normal "queued" success and the parent never
    // hears back — a silent hang, not a visible error.
    mocks.isChildRunLoopActive.mockReturnValue(false);
    mocks.wakeQueuedFollowUpStream.mockResolvedValue({
      kind: 'queued_resume_failed',
    });

    const tool = new DelegateAgentTool();
    const result = await tool.call({
      execution_id: executionId,
      instruction: 'Keep going.',
    });
    assert.strictEqual(result.status, 'executed');

    await vi.waitFor(() => {
      assert.strictEqual(mocks.deliverChildRunFollowUp.mock.calls.length, 1);
    });
    const [deliveryArgs] = mocks.deliverChildRunFollowUp.mock.calls;
    assert.strictEqual(deliveryArgs[0].targetStreamId, parentStreamId);
    assert.match(deliveryArgs[0].followUp.text, /<subagent-error/);
    assert.strictEqual(deliveryArgs[0].followUp.origin, 'subagent_result');
    assert.strictEqual(deliveryArgs[0].wake, true);
  });

  it('delivers a terminal error to the parent when the wake itself throws', async () => {
    mocks.isChildRunLoopActive.mockReturnValue(false);
    mocks.wakeQueuedFollowUpStream.mockRejectedValue(
      new Error('resume storage unreadable'),
    );

    const tool = new DelegateAgentTool();
    const result = await tool.call({
      execution_id: executionId,
      instruction: 'Keep going.',
    });
    assert.strictEqual(result.status, 'executed');

    await vi.waitFor(() => {
      assert.strictEqual(mocks.deliverChildRunFollowUp.mock.calls.length, 1);
    });
    const [deliveryArgs] = mocks.deliverChildRunFollowUp.mock.calls;
    assert.strictEqual(deliveryArgs[0].targetStreamId, parentStreamId);
    assert.match(deliveryArgs[0].followUp.text, /resume storage unreadable/);
  });
});
