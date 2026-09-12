// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import { formatToolResultTextWithAttachments } from '@agent/runtime/run/toolResultText';
import { BASH_APPROVAL_CONFIG_KEY, type ToolResult } from '@shared/schemas';
import { BashTool } from '@tools/bash';
import { requestBashApproval } from '@tools/approval/bashApproval';
import * as execUtils from '@utils/system/execUtils';
import * as agentConfig from '@utils/config/configUtils';

vi.mock('@tools/approval/bashApproval', async (importActual) => {
  const actual =
    await importActual<typeof import('@tools/approval/bashApproval')>();
  return {
    ...actual,
    // Default to auto-accept so tests unrelated to approval behavior (which
    // stub bash approval off via config) keep working; individual tests
    // override with mockResolvedValueOnce for the approval outcome they need.
    requestBashApproval: vi.fn(actual.requestBashApproval),
  };
});

function stubBashApprovalDisabled(): void {
  vi.spyOn(agentConfig, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T =>
      key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
  );
}

/** Lower a tool result the way a settled call reaches the model, and return
 * the model-visible text. */
function toolUseOutput(result: ToolResult): string {
  const { attachments, sanitizedResult } = extractToolAttachments(result);
  return formatToolResultTextWithAttachments(
    sanitizedResult,
    attachments,
    true,
  );
}

describe('BashTool error feedback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns foreground command failures in the model tool-result payload', async () => {
    stubBashApprovalDisabled();
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValueOnce({
      success: false,
      stdout: 'stdout failure guidance',
      stderr: 'stderr failure details',
      timedOut: false,
      exitCode: 2,
    });

    const result = await new BashTool().call({ command: 'echo long' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('Command failed');
    expect(result.error).toContain('stderr failure details');
    expect(result.error).toContain('stdout failure guidance');

    const output = toolUseOutput(result);

    expect(output).toContain('Command failed');
    expect(output).toContain('stderr failure details');
    expect(output).toContain('stdout failure guidance');
  });

  it.each([
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
    async ({ stderr, exitCode }) => {
      stubBashApprovalDisabled();
      vi.spyOn(execUtils, 'executeCommand').mockResolvedValueOnce({
        success: false,
        stdout: '',
        stderr,
        timedOut: false,
        exitCode,
      });

      const result = await new BashTool().call({ command: 'missing-command' });
      expect(result.status).toBe('error');
      expect(result.error).toContain(stderr);
    },
  );

  it('rejects shell-level backgrounding before command run', async () => {
    stubBashApprovalDisabled();
    const executeSpy = vi.spyOn(execUtils, 'executeCommand');

    const result = await new BashTool().call({
      command:
        'nohup python verify_residual_order.py > verify_residual_order_run.log 2>&1 &\necho "PID: $!"',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('shell-level backgrounding');
    expect(result.error).toContain('run_in_background: true');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('does not reject ampersands in later shell command segments', async () => {
    stubBashApprovalDisabled();
    const executeSpy = vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: 'done',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });

    const result = await new BashTool().call({
      command: 'nohup longtask; echo done &',
    });

    expect(result.status).toBe('executed');
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('reports an explicit approval rejection to the agent', async () => {
    vi.mocked(requestBashApproval).mockReturnValueOnce(
      Effect.succeed({ action: 'reject', feedback: 'No thanks.' }),
    );
    const rejected = await new BashTool().call({ command: 'echo rejected' });
    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('User rejected command');
    expect(rejected.userInstruction).toBe('No thanks.');
  });

  it('does not present generated rejection guidance as user feedback', async () => {
    vi.mocked(requestBashApproval).mockReturnValueOnce(
      Effect.succeed({ action: 'reject' }),
    );
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Do not retry');
    expect(rejected.userInstruction).toBeUndefined();

    const output = toolUseOutput(rejected);

    expect(output).toContain('Do not retry');
    expect(output).not.toContain('User feedback:');
  });

  it('does not present an approval-policy denial as user feedback', async () => {
    vi.mocked(requestBashApproval).mockReturnValueOnce(
      Effect.succeed({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      }),
    );
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).toContain('Denied by TeXRA approval policy.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();

    const output = toolUseOutput(rejected);

    expect(output).toContain('Denied by TeXRA approval policy.');
    expect(output).not.toContain('User feedback:');
  });

  it('preserves policy-denial provenance when its reason is blank', async () => {
    vi.mocked(requestBashApproval).mockReturnValueOnce(
      Effect.succeed({ action: 'deny', reason: '   ' }),
    );
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.error).not.toContain('Do not retry');
    expect(rejected.userInstruction).toBeUndefined();
  });

  it('does not present an automatic cancellation as user feedback', async () => {
    vi.mocked(requestBashApproval).mockReturnValueOnce(
      Effect.succeed({ action: 'cancel', cause: 'Session disposed.' }),
    );
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.error).toContain('Command cancelled');
    expect(rejected.error).toContain('Session disposed.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();
  });
});
