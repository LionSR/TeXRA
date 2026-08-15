// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';

// Local imports
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { OpenAIResponseToolCall } from '@agent/types/ModelHandlerContracts';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas';
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

class TestOpenAIResponseHandler extends ModelHandlerOpenAIResponse {
  async getClient(): Promise<never> {
    throw new Error('not used');
  }

  override async createResponse(): Promise<never> {
    throw new Error('not used');
  }

  override extractResponse(): never {
    throw new Error('not used');
  }
}

function createHandler(): TestOpenAIResponseHandler {
  return new TestOpenAIResponseHandler({
    name: 'test',
    label: 'Test',
    fullName: 'test',
    shortName: 'test',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 10,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });
}

function stubBashApprovalDisabled(): void {
  vi.spyOn(agentConfig, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T =>
      key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
  );
}

function createBashCall(): OpenAIResponseToolCall {
  return {
    provider: 'openai-response',
    callId: 'bash-1',
    name: 'bash',
    input: { command: 'echo long' },
    raw: {
      type: 'function_call',
      call_id: 'bash-1',
      name: 'bash',
      arguments: '{"command":"echo long"}',
    } as OpenAIResponseToolCall['raw'],
  };
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

    const { attachments, sanitizedResult } = extractToolAttachments(result);
    const messages = await createHandler().createToolUseFollowUpMessages(
      undefined,
      createBashCall(),
      sanitizedResult,
      attachments,
      AgentWorkspaceState.create(),
    );
    const toolResult = messages.find(
      (message) => message.type === 'function_call_output',
    );

    expect(toolResult?.output).toContain('Command failed');
    expect(toolResult?.output).toContain('stderr failure details');
    expect(toolResult?.output).toContain('stdout failure guidance');
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
        stdout: null,
        stderr,
        timedOut: false,
        exitCode,
      });

      const result = await new BashTool().call({ command: 'missing-command' });
      expect(result.status).toBe('error');
      expect(result.error).toContain(stderr);
    },
  );

  it('rejects shell-level backgrounding before command execution', async () => {
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
    vi.mocked(requestBashApproval).mockResolvedValueOnce({
      action: 'reject',
      feedback: 'No thanks.',
    });
    const rejected = await new BashTool().call({ command: 'echo rejected' });
    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('User rejected command');
    expect(rejected.userInstruction).toBe('No thanks.');
  });

  it('does not present generated rejection guidance as user feedback', async () => {
    vi.mocked(requestBashApproval).mockResolvedValueOnce({ action: 'reject' });
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Do not retry');
    expect(rejected.userInstruction).toBeUndefined();

    const { attachments, sanitizedResult } = extractToolAttachments(rejected);
    const messages = await createHandler().createToolUseFollowUpMessages(
      undefined,
      createBashCall(),
      sanitizedResult,
      attachments,
      AgentWorkspaceState.create(),
    );
    const toolResult = messages.find(
      (message) => message.type === 'function_call_output',
    );

    expect(toolResult?.output).toContain('Do not retry');
    expect(toolResult?.output).not.toContain('User feedback:');
  });

  it('does not present an approval-policy denial as user feedback', async () => {
    vi.mocked(requestBashApproval).mockResolvedValueOnce({
      action: 'reject',
      reason: 'Denied by TeXRA approval policy.',
    });
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).toContain('Denied by TeXRA approval policy.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();

    const { attachments, sanitizedResult } = extractToolAttachments(rejected);
    const messages = await createHandler().createToolUseFollowUpMessages(
      undefined,
      createBashCall(),
      sanitizedResult,
      attachments,
      AgentWorkspaceState.create(),
    );
    const toolResult = messages.find(
      (message) => message.type === 'function_call_output',
    );

    expect(toolResult?.output).toContain('Denied by TeXRA approval policy.');
    expect(toolResult?.output).not.toContain('User feedback:');
  });

  it('preserves policy-denial provenance when its reason is blank', async () => {
    vi.mocked(requestBashApproval).mockResolvedValueOnce({
      action: 'reject',
      reason: '   ',
    });
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.error).toContain('Command denied');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.error).not.toContain('Do not retry');
    expect(rejected.userInstruction).toBeUndefined();
  });

  it('does not present an automatic cancellation as user feedback', async () => {
    vi.mocked(requestBashApproval).mockResolvedValueOnce({
      action: 'reject',
      cause: 'Session disposed.',
    });
    const rejected = await new BashTool().call({ command: 'echo rejected' });

    expect(rejected.error).toContain('Command approval cancelled');
    expect(rejected.error).toContain('Session disposed.');
    expect(rejected.error).not.toContain('User rejected command');
    expect(rejected.userInstruction).toBeUndefined();
  });
});
