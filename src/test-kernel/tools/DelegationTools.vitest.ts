// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryUseRunContext: vi.fn(),
  currentSession: vi.fn(),
  submitFollowUp: vi.fn(),
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
  submitFollowUp: mocks.submitFollowUp,
}));

vi.mock('@tools/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

// Local imports
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { FileType, type FileStat } from '@platform/interfaces';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import {
  DelegateAgentTool,
  rejectOversizedBibAttachments,
} from '@tools/DelegationTools';
import { WorkspaceFS } from '@utils/files';

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

describe('DelegateAgentTool resume ownership', () => {
  const executionId = 'exec-resume-ownership';
  const parentStreamId = 'parent-stream' as StreamTabId;
  const childStreamId = 'child-stream' as StreamTabId;

  function makeHandle(): AgentExecutionHandle {
    return testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId,
      agent: 'review',
      category: AgentCategory.ToolUse,
      trace: { emit: vi.fn() } as never,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryUseRunContext.mockReturnValue({
      streamId: parentStreamId,
    } as never);
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: () => makeHandle() },
    } as never);
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
  });

  it('uses the merged submission result without a caller-local owner check', async () => {
    mocks.submitFollowUp.mockResolvedValue({
      status: 'queued',
      reason: 'waiting',
      continuation: 'live',
    });

    const result = await new DelegateAgentTool().call({
      execution_id: executionId,
      instruction: 'Keep going.',
    });

    assert.strictEqual(result.status, 'executed');
    assert.strictEqual(mocks.submitFollowUp.mock.calls.length, 1);
    assert.strictEqual(mocks.deliverChildRunFollowUp.mock.calls.length, 0);
  });

  it('reports a merged recovery failure to the parent', async () => {
    mocks.submitFollowUp.mockResolvedValue({
      status: 'queued',
      reason: 'waiting',
      continuation: 'resume_failed',
    });

    await new DelegateAgentTool().call({
      execution_id: executionId,
      instruction: 'Keep going.',
    });

    await vi.waitFor(() =>
      assert.strictEqual(mocks.deliverChildRunFollowUp.mock.calls.length, 1),
    );
  });
});
