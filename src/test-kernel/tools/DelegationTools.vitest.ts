import * as assert from 'node:assert';
import { Effect } from 'effect';
// Node imports

// Third-party imports
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryUseRunContext: vi.fn(),
  currentSession: vi.fn(),
  submitFollowUp: vi.fn(),
}));

vi.mock('@agent/runtime/RunContext', () => {
  const readRunContextField = (context: any, field: string) =>
    context?.kind === 'launch' ? context.runScope[field] : context?.[field];
  return {
    tryUseRunContext: mocks.tryUseRunContext,
    getRunContextRunId: (context: any) => readRunContextField(context, 'runId'),
  };
});

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/followUp/ToolUseFollowUp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/followUp/ToolUseFollowUp')>()),
  submitFollowUp: mocks.submitFollowUp,
}));

// Local imports
import type { RunHandle } from '@agent/runtime/RunHandle';
import { FileType, type FileStat } from '@platform/interfaces';
import { AgentCategory, type RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
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
});

describe('DelegateAgentTool resume ownership', () => {
  const runId = 'ce5c3e0a1d77' as RunId;
  const parentRunId = 'ba7e0f19c2d4' as RunId;

  function makeHandle(): RunHandle {
    return testRunHandle({
      runId,
      parent: parentRunId,
      agent: 'review',
      category: AgentCategory.ToolUse,
      trace: { emit: vi.fn() } as never,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryUseRunContext.mockReturnValue({
      runId: parentRunId,
    } as never);
    mocks.currentSession.mockReturnValue({
      runs: { getHandle: () => makeHandle() },
    } as never);
  });

  it('reports a merged recovery failure to the parent', async () => {
    mocks.submitFollowUp.mockReturnValue(
      Effect.succeed({
        status: 'queued',
        wake: 'failed',
      }),
    );

    await new DelegateAgentTool().call({
      execution_id: runId,
      instruction: 'Keep going.',
    });

    await vi.waitFor(() =>
      assert.strictEqual(mocks.submitFollowUp.mock.calls.length, 2),
    );
    expect(mocks.submitFollowUp).toHaveBeenLastCalledWith(
      parentRunId,
      expect.objectContaining({ origin: 'subagent_result' }),
      expect.anything(),
    );
  });
});
