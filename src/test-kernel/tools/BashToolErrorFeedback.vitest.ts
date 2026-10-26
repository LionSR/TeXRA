import { it } from '@effect/vitest';
// Test composition imports

// Third-party imports
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '@agent/runtime/run/toolResultText';
import type { RunId } from '@shared/schemas';
import { type ToolResult } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { BashTool } from '@tools/bash';
import { buildBashApprovalRejectedResult } from '@tools/approval/bashApproval';
import * as execUtils from '@utils/system/execUtils';

/** Lower a tool result the way a settled call reaches the model, and return
 * the model-visible text. */
function toolUseOutput(result: ToolResult): string {
  const { attachments, sanitizedResult } = extractToolAttachments(result);
  return formatToolResultAsText(
    sanitizedResult,
    attachments.length > 0 ? formatAttachmentSummary(attachments) : undefined,
  );
}

describe('BashTool error feedback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('rejects shell-level backgrounding before command run', () =>
    Effect.gen(function* () {
      const executeSpy = vi.spyOn(execUtils, 'executeCommand');

      const result = yield* BashTool.call({
        command:
          'nohup python verify_residual_order.py > verify_residual_order_run.log 2>&1 &\necho "PID: $!"',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('shell-level backgrounding');
      expect(result.error).toContain('run_in_background: true');
      expect(executeSpy).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('does not reject ampersands in later shell command segments', () =>
    Effect.gen(function* () {
      const executeSpy = vi.spyOn(execUtils, 'executeCommand').mockReturnValue(
        Effect.succeed({
          success: true,
          stdout: 'done',
          stderr: '',
          timedOut: false,
          exitCode: 0,
        }),
      );

      const result = yield* BashTool.call({
        command: 'nohup longtask; echo done &',
      });

      expect(result.status).toBe('executed');
      expect(executeSpy).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it('does not present generated rejection guidance as user feedback', () => {
    const rejected = buildBashApprovalRejectedResult('echo rejected', {
      action: 'reject',
    });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Do not retry');
    expect(rejected.userInstruction).toBeUndefined();

    const output = toolUseOutput(rejected);

    expect(output).toContain('Do not retry');
    expect(output).not.toContain('User feedback:');
  });

  it('does not present an approval-policy denial as user feedback', () => {
    const rejected = buildBashApprovalRejectedResult('echo rejected', {
      action: 'deny',
      reason: 'Denied by the approval policy.',
    });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).toContain('Denied by the approval policy.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();

    const output = toolUseOutput(rejected);

    expect(output).toContain('Denied by the approval policy.');
    expect(output).not.toContain('User feedback:');
  });
});
