// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';

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

vi.mock('@agent/followUp/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

// Local imports
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { FileType, type FileStat } from '@platform/interfaces';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import {
  rejectOversizedBibAttachments,
  WorkflowAgentInputSchema,
  withToolUseSubagentHandoffInstruction,
  workingDirectoryField,
} from '@tools/delegation/inputFields';
import { WorkspaceFS } from '@utils/files/workspaceFS';

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

  it.each([
    {
      name: 'rejects context .bib files larger than 100KB',
      sizeBytes: 100 * 1024 + 1,
      paths: ['references.bib'],
      rejectedPath: 'references.bib',
      formattedSize: '100 KiB',
    },
    {
      name: 'rejects context .bib files in the multi-list larger than 100KB',
      sizeBytes: 150 * 1024,
      paths: ['paper.tex', 'bibliography/main.bib'],
      rejectedPath: 'bibliography/main.bib',
      formattedSize: '150 KiB',
    },
  ])('$name', async ({ sizeBytes, paths, rejectedPath, formattedSize }) => {
    WorkspaceFS.stat = async () => stat(sizeBytes);

    const result = await rejectOversizedBibAttachments(paths);

    assert.strictEqual(result?.status, 'error');
    assert.strictEqual(result?.summary, 'Rejected oversized BibTeX attachment');
    assert.strictEqual(
      result?.error,
      `${rejectedPath} is ${sizeBytes} bytes (${formattedSize}), over the 102400 byte (100 KiB) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`,
    );
    assert.deepStrictEqual(result?.diagnostics, {
      type: 'oversized_bib_attachment',
      path: rejectedPath,
      sizeBytes,
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

  it('keeps delegation field and handoff copy free of em dashes', () => {
    const fieldDescriptions = [
      ...Object.values(WorkflowAgentInputSchema.shape).map(
        (field) => field.description,
      ),
      workingDirectoryField.description,
    ];
    const delegatedInstruction = 'User \u2014 instruction.';
    const parentInstruction = 'Parent \u2014 instruction.';
    const handoff = withToolUseSubagentHandoffInstruction(
      delegatedInstruction,
      parentInstruction,
    );

    expect(handoff).toContain(
      `Parent user request (constraint context only):\n${parentInstruction}`,
    );
    expect(handoff).toContain(
      'Constraints in the parent user request are mandatory and override conflicting delegated-task wording.',
    );
    expect(handoff).toMatch(
      /Your final response is delivered verbatim to the parent orchestrator\..*never only a status note such as "done"\.$/,
    );

    const authoredHandoff = handoff
      .replace(delegatedInstruction, '')
      .replace(parentInstruction, '');
    expect(`${fieldDescriptions.join('\n')}\n${authoredHandoff}`).not.toContain(
      '\u2014',
    );
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
