// Third-party imports
import * as assert from 'node:assert';
import { describe, it, afterEach, beforeEach, vi } from 'vitest';

// Node.js built-in imports

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces';

const mocks = vi.hoisted(() => ({
  tryUseRunContext: vi.fn(),
  currentSession: vi.fn(),
  sendFollowUp: vi.fn(),
  wakeQueuedFollowUpStream: vi.fn(),
  getNativeSubagentStrategy: vi.fn(),
}));

vi.mock('@agent/runtime/RunContext', () => ({
  tryUseRunContext: mocks.tryUseRunContext,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: mocks.sendFollowUp,
  wakeQueuedFollowUpStream: mocks.wakeQueuedFollowUpStream,
}));

vi.mock('@tools/delegation/nativeSubagentStrategy', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@tools/delegation/nativeSubagentStrategy')
    >();
  return {
    ...actual,
    getNativeSubagentStrategy: mocks.getNativeSubagentStrategy,
  };
});

// Local imports - agent
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import type { FollowUpWakeResult } from '@agent/followUp/ToolUseFollowUp';

// Local imports - shared
import { AgentCategory, type StreamTabId } from '@shared/schemas';

// Local imports - tools
import {
  DelegateAgentTool,
  rejectOversizedBibAttachments,
  type WorkflowAgentInput,
} from '@tools/DelegationTools';
import { SharedSubagentDeliveryRegistry } from '@tools/subagentDeliveryState';
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

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['references.bib'],
    });

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

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['paper.tex', 'bibliography/main.bib'],
    });

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

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['library.bib'],
    });

    assert.strictEqual(result, null);
  });

  it('ignores non-bib context files', async () => {
    let statCalled = false;
    WorkspaceFS.stat = async () => {
      statCalled = true;
      return stat(500 * 1024);
    };

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['paper.tex', 'preamble.tex'],
    });

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
      delegationDepth: 0,
      streamId: parentStreamId,
    } as never);
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: () => makeHandle() },
    } as never);
    mocks.sendFollowUp.mockResolvedValue({
      status: 'queued',
      reason: 'waiting',
    });
    SharedSubagentDeliveryRegistry.start(executionId);
  });

  afterEach(() => {
    SharedSubagentDeliveryRegistry.finish(executionId);
  });

  it('returns once the follow-up is queued, without waiting for a resumed native subagent to reach its next boundary', async () => {
    let resolveWake: ((value: FollowUpWakeResult) => void) | undefined;
    const wakeQueuedFollowUp = vi.fn(
      () =>
        new Promise<FollowUpWakeResult>((resolve) => {
          resolveWake = resolve;
        }),
    );
    mocks.getNativeSubagentStrategy.mockReturnValue({ wakeQueuedFollowUp });

    const tool = new DelegateAgentTool();
    const outcome = await raceAgainstBlockingResume(
      tool.call({ execution_id: executionId, instruction: 'Keep going.' }),
    );

    assert.strictEqual(
      outcome.settled,
      true,
      'delegate_agent resume blocked the parent tool call for the full child turn',
    );
    if (outcome.settled) {
      assert.strictEqual(outcome.value.status, 'executed');
    }
    assert.strictEqual(wakeQueuedFollowUp.mock.calls.length, 1);

    // Settle the still-pending wake so it doesn't leak into later tests.
    resolveWake?.({ kind: 'resumed' });
  });

  it('returns once the follow-up is queued, without waiting for the host resume port when no native strategy is registered', async () => {
    mocks.getNativeSubagentStrategy.mockReturnValue(undefined);
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

    resolveWake?.({ kind: 'resumed' });
  });
});
