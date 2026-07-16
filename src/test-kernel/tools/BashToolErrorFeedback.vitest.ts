// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';

// Local imports - agent state
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';

// Local imports - model handlers
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { OpenAIResponseToolCall } from '@agent/types/ModelHandlerContracts';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';

// Local imports - tools
import { BashTool } from '@tools/bash';
import { requestBashApproval } from '@tools/approval/bashApproval';
import * as agentConfig from '@utils/config/configUtils';

// Local imports - system utilities
import * as execUtils from '@utils/system/execUtils';

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

  it('reports a real rejection distinctly from an approval timeout', async () => {
    // Regression coverage for #7444: a host-side approval timeout must not
    // collapse into the same "User rejected command" shape as an
    // explicit reject once it reaches the agent.
    vi.mocked(requestBashApproval).mockResolvedValueOnce({
      accepted: false,
      userMessage: 'No thanks.',
    });
    const rejected = await new BashTool().call({ command: 'echo rejected' });
    expect(rejected.status).toBe('error');
    expect(rejected.error).toContain('User rejected command');

    vi.mocked(requestBashApproval).mockResolvedValueOnce({
      accepted: false,
      userMessage: 'Approval request timed out.',
      timedOut: true,
    });
    const timedOut = await new BashTool().call({ command: 'echo timeout' });
    expect(timedOut.status).toBe('error');
    expect(timedOut.error).not.toContain('User rejected command');
    expect(timedOut.error).toContain('timed out');
  });
});
