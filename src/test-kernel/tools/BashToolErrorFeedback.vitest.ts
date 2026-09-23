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

  it.effect(
    'returns foreground command failures in the model tool-result payload',
    () =>
      Effect.gen(function* () {
        vi.spyOn(execUtils, 'executeCommand').mockReturnValueOnce(
          Effect.succeed({
            success: false,
            stdout: 'stdout failure guidance',
            stderr: 'stderr failure details',
            timedOut: false,
            exitCode: 2,
          }),
        );

        const result = yield* BashTool.call({ command: 'echo long' });
        expect(result.status).toBe('error');
        expect(result.error).toContain('Command failed');
        expect(result.error).toContain('stderr failure details');
        expect(result.error).toContain('stdout failure guidance');

        const output = toolUseOutput(result);

        expect(output).toContain('Command failed');
        expect(output).toContain('stderr failure details');
        expect(output).toContain('stdout failure guidance');
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

  it.effect.each([
    {
      name: 'spawn failure',
      stderr: 'spawn missing-command ENOENT',
      exitCode: 127,
    },
    {
      name: 'cancellation',
      stderr: 'Command aborted by user',
      exitCode: 130,
    },
  ])(
    'preserves $name fallback diagnostics without stream chunks',
    ({ stderr, exitCode }) =>
      Effect.gen(function* () {
        vi.spyOn(execUtils, 'executeCommand').mockReturnValueOnce(
          Effect.succeed({
            success: false,
            stdout: '',
            stderr,
            timedOut: false,
            exitCode,
          }),
        );

        const result = yield* BashTool.call({
          command: 'missing-command',
        });
        expect(result.status).toBe('error');
        expect(result.error).toContain(stderr);
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

  // The refusal copy a call settles with. Approval is the run loop's
  // declared guard now, not a step in the body, so the copy is asserted at
  // the builder the guard hands its decision to.
  it('reports an explicit approval rejection to the agent', () => {
    const rejected = buildBashApprovalRejectedResult('echo rejected', {
      action: 'reject',
      feedback: 'No thanks.',
    });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('User rejected command');
    expect(rejected.userInstruction).toBe('No thanks.');
  });

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
      reason: 'Denied by TeXRA approval policy.',
    });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).toContain('Denied by TeXRA approval policy.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();

    const output = toolUseOutput(rejected);

    expect(output).toContain('Denied by TeXRA approval policy.');
    expect(output).not.toContain('User feedback:');
  });

  it('preserves policy-denial provenance when its reason is blank', () => {
    const rejected = buildBashApprovalRejectedResult('echo rejected', {
      action: 'deny',
      reason: '   ',
    });

    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.error).not.toContain('Do not retry');
    expect(rejected.userInstruction).toBeUndefined();
  });

  it('does not present an automatic cancellation as user feedback', () => {
    const rejected = buildBashApprovalRejectedResult('echo rejected', {
      action: 'cancel',
      cause: 'Session disposed.',
    });

    expect(rejected.error).toContain('Command cancelled');
    expect(rejected.error).toContain('Session disposed.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();
  });
});
