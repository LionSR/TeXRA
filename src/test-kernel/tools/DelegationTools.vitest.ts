// Node.js built-in imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces/filesystem';

// Local imports - tests
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - agent
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { clearRuntimeStreamStatus } from '@agent/runtime/streamControl';

// Local imports - shared
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

// Local imports - tools
import {
  DelegateAgentTool,
  rejectOversizedBibAttachments,
  type WorkflowAgentInput,
} from '@tools/DelegationTools';
import { subagentDeliveryRegistry } from '@tools/subagentDeliveryState';

// Local imports - utils
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

    assert.strictEqual(result?.isError, true);
    assert.strictEqual(result?.summary, 'Rejected oversized BibTeX attachment');
    assert.strictEqual(
      result?.error,
      'references.bib is 102401 bytes (100 KiB), over the 102400 byte (100 KiB) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.',
    );
    assert.strictEqual(result?.output, result?.error);
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

    assert.strictEqual(result?.isError, true);
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

  it('resumes subagents through the runtime follow-up command', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({ workspacePath: '/workspace' }));

    const session = new SessionHandle();
    const parentStreamId = 'delegate-resume-parent' as StreamTabId;
    const childStreamId = 'delegate-resume-child' as StreamTabId;
    const executionId = 'delegate-resume-execution';
    const runtimeHost = { emit: vi.fn() };

    try {
      const handle = new AgentExecutionHandle(
        executionId,
        parentStreamId,
        childStreamId,
        'assistant',
        'toolUse',
        runtimeHost,
      );
      session.executions.trackAgentExecution(handle, {
        status: STREAM_STATUS.WAITING,
      });
      subagentDeliveryRegistry.start(executionId);

      const result = await withRunContext(
        createRunContext({
          runtimeHost,
          streamId: parentStreamId,
          session,
        }),
        () =>
          new DelegateAgentTool().call({
            execution_id: executionId,
            instruction: 'Also check the boundary term.',
          }),
      );

      if (result.isError) {
        assert.fail(result.error);
      }
      assert.strictEqual(result.summary, "Follow-up queued for 'assistant'");
      assert.match(result.output ?? '', /\(waiting\)/);
      assert.deepStrictEqual(ToolUseFollowUpQueue.getAll(childStreamId), [
        [
          '<orchestrator-followup>',
          'Also check the boundary term.',
          '</orchestrator-followup>',
        ].join('\n'),
      ]);
      assert.ok(
        runtimeHost.emit.mock.calls.some(
          ([event, payload]) =>
            event === 'updateQueuedFollowUps' &&
            payload.streamId === childStreamId &&
            payload.messages.length === 1,
        ),
      );
    } finally {
      subagentDeliveryRegistry.finish(executionId);
      session.dispose();
      clearRuntimeStreamStatus(childStreamId);
      ToolUseFollowUpQueue.release(childStreamId);
    }
  });
});
