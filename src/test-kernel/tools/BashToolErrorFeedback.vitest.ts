// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';

// Local imports - agent state
import * as agentConfig from '@agent/core/config';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

// Local imports - model handlers
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import { extractToolAttachments } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import type { OpenAIResponseToolCall } from '@agent/modelHandlers/types/IModelHandler';

// Local imports - tools
import { BashTool } from '@tools/bash';
import { BASH_APPROVAL_CONFIG_KEY } from '@tools/approval/bashApproval';

// Local imports - system utilities
import * as execUtils from '@utils/system/execUtils';

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
    vi.spyOn(agentConfig, 'getConfig').mockImplementation(
      <T>(key: string, defaultValue?: T): T => {
        if (key === BASH_APPROVAL_CONFIG_KEY) return false as T;
        return defaultValue as T;
      },
    );
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValueOnce({
      success: false,
      stdout: 'stdout failure guidance',
      stderr: 'stderr failure details',
      timedOut: false,
      exitCode: 2,
    });

    const result = await new BashTool().call({ command: 'echo long' });
    expect(result.isError).toBe(true);
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
    vi.spyOn(agentConfig, 'getConfig').mockImplementation(
      <T>(key: string, defaultValue?: T): T => {
        if (key === BASH_APPROVAL_CONFIG_KEY) return false as T;
        return defaultValue as T;
      },
    );
    const executeSpy = vi.spyOn(execUtils, 'executeCommand');

    const result = await new BashTool().call({
      command:
        'nohup python verify_residual_order.py > verify_residual_order_run.log 2>&1 &\necho "PID: $!"',
    });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('shell-level backgrounding');
    expect(result.error).toContain('run_in_background: true');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('does not reject ampersands in later shell command segments', async () => {
    vi.spyOn(agentConfig, 'getConfig').mockImplementation(
      <T>(key: string, defaultValue?: T): T => {
        if (key === BASH_APPROVAL_CONFIG_KEY) return false as T;
        return defaultValue as T;
      },
    );
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

    expect(result.isError).not.toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
  });
});
