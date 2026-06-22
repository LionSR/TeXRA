// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, beforeAll, afterEach, vi } from 'vitest';

// Node.js built-in imports

// Local imports - tests
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - agent core
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';
import { createRunTrace } from '@transcript';
import type { AgentEvent } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import { ToolUseDispatchNode } from '@agent/core/flows/toolUseRound/ToolUseDispatchNode';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
// Type imports
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';

// Local imports - agent runtime
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';

// Internal imports
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { StreamTabId } from '@shared/schemas';
import type { ExecResult } from '@shared/schemas/opResults';
import { BashTool } from '@tools/bash';
import { TaskRunFileService } from '@utils/files';
import * as execUtils from '@utils/system/execUtils';

// Type imports
import type OpenAI from 'openai';

const testModelConfig: ModelConfig = {
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
};

class BashMockHandler extends ModelHandlerOpenAIResponse {
  private callCount = 0;

  async getClient(): Promise<OpenAI> {
    return {} as OpenAI;
  }

  // createResponse returns a CreateResponseResult wrapper around the raw
  // provider response (see IModelHandler.createResponse).
  override async createResponse(): Promise<any> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        response: {
          id: 'bash-call',
          status: 'completed',
          output_text: 'running bash',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'running bash', annotations: [] },
              ],
            },
            {
              type: 'function_call',
              call_id: 'bash-1',
              name: 'bash',
              arguments: '{"command":"echo long"}',
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      };
    }
    return {
      response: {
        id: 'bash-complete',
        status: 'completed',
        output_text: 'done',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    };
  }

  override extractResponse(resp: any) {
    if (resp.id === 'bash-call') {
      return {
        text: 'running bash',
        usage: resp.usage,
        stopReason: 'stop',
      };
    }
    if (resp.id === 'bash-complete') {
      return { text: 'done', usage: resp.usage, stopReason: 'stop' };
    }
    return { text: '', usage: resp.usage, stopReason: 'stop' };
  }
}

describe('BashTool', () => {
  beforeAll(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        workspacePath: '/workspace',
        // Unit tests exercise the tool directly — no approval host is wired.
        config: { 'texra.toolUse.requireBashApproval': false },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves long stdout for tool results and model payloads', async () => {
    const longOutput = '0123456789'.repeat(35); // 350 chars, exceeds log truncation of 150
    const execResult: ExecResult = {
      success: true,
      // executeCommand trims trailing whitespace before returning stdout
      stdout: `${longOutput}\n`.trim(),
      stderr: null,
      timedOut: false,
    };

    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      async (_command, options = {}) => {
        receivedSignal = options.signal;
        return execResult;
      },
    );

    const bashTool = new BashTool();
    const directResult = await bashTool.call({ command: 'echo long' });
    assert.equal(
      directResult.output,
      longOutput,
      'Bash tool should return the full stdout text',
    );

    const handler = new BashMockHandler(testModelConfig);
    const workspaceState = AgentWorkspaceState.create();
    const run = AgentRunStateSnapshotSchema.parse({});
    const options: ToolUseRoundServices<OpenAI> = {
      modelHandler: handler,
      config: testModelConfig as any,
      setting: {
        agentCategory: AgentCategory.ToolUse,
        documentTag: 'doc',
        temperature: 0,
        endTag: '</doc>',
        requiredFiles: {},
        requiredFilesInternal: {},
        defaultOutputFiles: [],
        filePatternsContain: [],
        tools: [{ name: 'bash' }],
      } satisfies AgentSetting,
      prompt: {
        systemPrompt: '',
        userPrefix: '',
        userRequest: '',
      } satisfies AgentPrompt,
      userVarChannels: { input: {}, transient: {} },
      logger: createRunTrace('BashToolTest').trace,
      runtimeHost: noopAgentRuntimeHost,
      streamStatus: new StreamStatusRegistry(),
      client: {} as OpenAI,
      fileService: new TaskRunFileService('test-execution-id'),
      toolRegistry: new MapToolRegistry({ bash: bashTool }),
      checkInterruption: () => false,
      setAbortController: () => {},
      streamId: 'bash-tool' as StreamTabId,
      executionId: 'test-execution-id',
      run,
      workspace: workspaceState,
      bestConnectionMethod: async () => ({ connector: ' ', choice: 'B' }),
    };

    const messages: ProviderMessage[] = [];

    // Create shared state for the round flow (flat pattern)
    // Tool-use rounds track metrics in shared (roundIndex, etc.) instead of round object
    const shared: ToolUseRoundShared = {
      messages,
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      roundIndex: 0,
      roundResponseTimeMs: 0,
      roundNormalizedUsage: undefined,
    };

    // Create and run the flow directly
    const flow = createToolUseRoundFlow();
    flow.setServices(options);
    await flow.run(shared);

    const toolOutputMessage = messages.find(
      (msg) => (msg as any).type === 'function_call_output',
    ) as any;
    assert.ok(toolOutputMessage, 'Tool output message was not produced');
    assert.ok(
      typeof toolOutputMessage.output === 'string' &&
        toolOutputMessage.output.includes(longOutput),
      'Model follow-up payload should contain the complete stdout text',
    );
    assert.ok(
      receivedSignal,
      'Bash command should receive the active tool-call abort signal',
    );
    assert.equal(receivedSignal.aborted, false);
  });

  it('accepts optional command descriptions without passing them to the shell', async () => {
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: 'checked\n',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });

    const result = await new BashTool().call({
      command: 'test -f proof.tex',
      description: 'Check that the proof file exists.',
    });

    assert.equal(result.output, 'checked\n');
    assert.equal(
      vi.mocked(execUtils.executeCommand).mock.calls[0]?.[0],
      'test -f proof.tex',
    );
  });

  it('finalizes deferred progress card when foreground bash is aborted', async () => {
    let activeController: AbortController | null = null;
    let receivedSignal: AbortSignal | undefined;

    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      async (_command, options = {}) => {
        receivedSignal = options.signal;
        options.onStdout?.('started\n');
        activeController?.abort();
        return {
          success: false,
          stdout: null,
          stderr: 'Command aborted by user',
          timedOut: false,
          exitCode: 130,
        };
      },
    );

    const runTrace = createRunTrace('BashToolAbortTest' as StreamTabId);
    const events: AgentEvent[] = [];
    const unsubscribe = runTrace.trace.subscribe((event) => {
      events.push(event);
    });

    const node = new ToolUseDispatchNode<OpenAI>();
    const bashTool = new BashTool();
    const workspaceState = AgentWorkspaceState.create();
    const run = AgentRunStateSnapshotSchema.parse({});
    const options: ToolUseRoundServices<OpenAI> = {
      modelHandler: new BashMockHandler(testModelConfig),
      config: testModelConfig as any,
      setting: {
        agentCategory: AgentCategory.ToolUse,
        documentTag: 'doc',
        temperature: 0,
        endTag: '</doc>',
        requiredFiles: {},
        requiredFilesInternal: {},
        defaultOutputFiles: [],
        filePatternsContain: [],
        tools: [{ name: 'bash' }],
      } satisfies AgentSetting,
      prompt: {
        systemPrompt: '',
        userPrefix: '',
        userRequest: '',
      } satisfies AgentPrompt,
      userVarChannels: { input: {}, transient: {} },
      logger: runTrace.trace,
      runtimeHost: noopAgentRuntimeHost,
      streamStatus: new StreamStatusRegistry(),
      client: {} as OpenAI,
      fileService: new TaskRunFileService('test-execution-id'),
      toolRegistry: new MapToolRegistry({ bash: bashTool }),
      checkInterruption: () => activeController?.signal.aborted ?? false,
      setAbortController: (controller) => {
        activeController = controller;
      },
      streamId: 'bash-tool' as StreamTabId,
      executionId: 'test-execution-id',
      run,
      workspace: workspaceState,
      bestConnectionMethod: async () => ({ connector: ' ', choice: 'B' }),
    };

    const call = {
      provider: 'google',
      callId: 'bash-abort-1',
      name: 'bash',
      input: { command: 'echo long' },
      raw: { name: 'bash', args: { command: 'echo long' } },
    } as SdkToolCall;

    try {
      node.setServices(options);
      const result = await node.exec(call);

      assert.equal(result, null);
      assert.ok(receivedSignal, 'Bash command should receive an abort signal');
      assert.equal(receivedSignal.aborted, true);

      const toolEvents = events.filter(
        (event) => event.type === 'tool.start' || event.type === 'tool.end',
      );
      assert.equal(toolEvents[0]?.type, 'tool.start');

      const startedLogId =
        toolEvents[0]?.type === 'tool.start' ? toolEvents[0].logId : null;
      const progressEvent = toolEvents.find(
        (event) => event.type === 'tool.end' && event.status === 'in_progress',
      );
      const failedEvent = toolEvents.findLast(
        (event) => event.type === 'tool.end' && event.status === 'failed',
      );

      assert.ok(progressEvent, 'Streaming output should update the card');
      assert.ok(failedEvent, 'Abort should close the progress card as failed');
      if (progressEvent?.type === 'tool.end') {
        assert.equal(progressEvent.logId, startedLogId);
      }
      if (failedEvent?.type === 'tool.end') {
        assert.equal(failedEvent.logId, startedLogId);
      }
    } finally {
      unsubscribe();
      runTrace.dispose();
    }
  });
});
