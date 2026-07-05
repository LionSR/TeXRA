// Third-party imports
import * as assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';

// Local imports - tests
import { setupPlatform } from '@test/support/setupPlatform';

// Local imports - agent types
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';

// Local imports - tools
import type { StreamTabId } from '@shared/schemas';
import { cleanupAllApprovals } from '@tools/approval';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

/**
 * Proves the desktop multi-window fix: two runs with distinct
 * `toolEditApprovalHandler`s on their `RunContext` never cross-talk, even when
 * both requests are in flight at once (the shared approval queue serializes
 * execution but must not leak which handler a given request resolves through).
 * Before this fix, every host routed through the single process-wide
 * `platform().toolEditApproval` port, so a second window's handler silently
 * stole the first window's in-flight prompt.
 */
describe('Concurrent per-run tool edit approval handlers', () => {
  setupPlatform(
    { workspacePath: '/workspace', config: {}, files: {} },
    {
      toolEditApproval: () => {
        throw new Error(
          'platform().toolEditApproval should not be reached when the ' +
            'RunContext supplies its own toolEditApprovalHandler',
        );
      },
    },
  );

  beforeEach(() => {
    cleanupAllApprovals();
  });

  afterEach(() => {
    cleanupAllApprovals();
  });

  it('routes each in-flight request through its own run handler, never the other', async () => {
    const seenByA: ToolEditApprovalRequest[] = [];
    const seenByB: ToolEditApprovalRequest[] = [];

    const handlerA = async (
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult> => {
      seenByA.push(request);
      return { accepted: true, appliedContent: 'from-a' };
    };
    const handlerB = async (
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult> => {
      seenByB.push(request);
      return { accepted: true, appliedContent: 'from-b' };
    };

    const contextA = createRunContext({
      runtimeHost: noopAgentRuntimeHost,
      streamId: 'windowA@model: test.tex' as StreamTabId,
      toolEditApprovalHandler: handlerA,
    });
    const contextB = createRunContext({
      runtimeHost: noopAgentRuntimeHost,
      streamId: 'windowB@model: test.tex' as StreamTabId,
      toolEditApprovalHandler: handlerB,
    });

    const requestA: ToolEditApprovalRequest = {
      path: 'a.tex',
      originalContent: 'old-a',
      proposedContent: 'new-a',
      sourceTool: 'write_file',
    };
    const requestB: ToolEditApprovalRequest = {
      path: 'b.tex',
      originalContent: 'old-b',
      proposedContent: 'new-b',
      sourceTool: 'write_file',
    };

    // Fire both without awaiting between them — the shared approval queue
    // serializes execution, but each call must still resolve through the
    // handler captured from its own RunContext, not whichever ran last.
    const resultAPromise = withRunContext(contextA, () =>
      requestToolEditApproval(requestA),
    );
    const resultBPromise = withRunContext(contextB, () =>
      requestToolEditApproval(requestB),
    );

    const [resultA, resultB] = await Promise.all([
      resultAPromise,
      resultBPromise,
    ]);

    assert.strictEqual(seenByA.length, 1);
    assert.strictEqual(seenByA[0]?.path, 'a.tex');
    assert.strictEqual(seenByB.length, 1);
    assert.strictEqual(seenByB[0]?.path, 'b.tex');

    assert.strictEqual(resultA.appliedContent, 'from-a');
    assert.strictEqual(resultB.appliedContent, 'from-b');
  });
});
