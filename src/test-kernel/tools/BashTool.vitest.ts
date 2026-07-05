// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, vi } from 'vitest';

// Local imports - tests
import { setupPlatform } from '@test/support/setupPlatform';

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
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
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
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';

// Internal imports
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { MAX_TOOL_RESULT_TEXT_LENGTH } from '@agent/modelHandlers/contextManagementConstants';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import type { StreamTabId } from '@shared/schemas';
import type { ExecResult } from '@shared/schemas/opResults';
import { BashTool } from '@tools/bash';
import { TaskRunFileService } from '@utils/files';
import * as execUtils from '@utils/system/execUtils';
import { withTestRunContext } from '../agent/progressTestUtils';

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

/**
 * Build the tool-use round services shared by every case. Only the tool name,
 * logger, stream id, registry, and interruption hooks vary between tests.
 */
function roundServices(opts: {
  toolName: string;
  logger: ToolUseRoundServices<OpenAI>['logger'];
  streamId: StreamTabId;
  toolRegistry: ToolUseRoundServices<OpenAI>['toolRegistry'];
  checkInterruption?: () => boolean;
  setAbortController?: (controller: AbortController | null) => void;
}): ToolUseRoundServices<OpenAI> {
  return {
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
      tools: [{ name: opts.toolName }],
    } satisfies AgentSetting,
    prompt: {
      systemPrompt: '',
      userPrefix: '',
      userRequest: '',
    } satisfies AgentPrompt,
    userVarChannels: { input: {}, transient: {} },
    logger: opts.logger,
    streamStatus: new StreamStatusMachine(),
    client: {} as OpenAI,
    fileService: new TaskRunFileService('deadbeef'),
    toolRegistry: opts.toolRegistry,
    checkInterruption: opts.checkInterruption ?? (() => false),
    setAbortController: opts.setAbortController ?? (() => {}),
    run: AgentRunStateSnapshotSchema.parse({}),
    workspace: AgentWorkspaceState.create(),
  };
}

function freshRoundShared(messages: ProviderMessage[]): ToolUseRoundShared {
  return {
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
}

describe('BashTool', () => {
  setupPlatform({
    workspacePath: '/workspace',
    // Unit tests exercise the tool directly — no approval host is wired.
    config: { 'texra.toolUse.requireBashApproval': false },
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

    const options = roundServices({
      toolName: 'bash',
      logger: createRunTrace('BashToolTest').trace,
      streamId: 'bash-tool' as StreamTabId,
      toolRegistry: new MapToolRegistry({ bash: bashTool }),
    });

    const messages: ProviderMessage[] = [];
    const shared = freshRoundShared(messages);

    // Create and run the flow directly
    const flow = createToolUseRoundFlow();
    flow.setServices(options);
    await withTestRunContext(noopAgentRuntimeHost, 'bash-tool', () =>
      flow.run(shared),
    );

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

  it('keeps result status out of visible tool log output', async () => {
    const runTrace = createRunTrace('ToolStatusLogTest' as StreamTabId);
    const events: AgentEvent[] = [];
    const unsubscribe = runTrace.trace.subscribe((event) => {
      events.push(event);
    });

    try {
      const options = roundServices({
        toolName: 'empty',
        logger: runTrace.trace,
        streamId: 'tool-status-log' as StreamTabId,
        toolRegistry: new MapToolRegistry({}),
      });

      const call = {
        provider: 'openai',
        callId: 'empty-1',
        name: 'empty',
        input: '{}',
        raw: {
          id: 'empty-1',
          type: 'function',
          function: {
            name: 'empty',
            arguments: '{}',
          },
        },
      } as SdkToolCall;
      const messages: ProviderMessage[] = [];
      const shared = freshRoundShared(messages);

      const node = new ToolUseDispatchNode<OpenAI>();
      node.setServices(options);
      await withTestRunContext(noopAgentRuntimeHost, 'tool-status-log', () =>
        node.post(
          shared,
          [call],
          [
            {
              call,
              result: {},
              parsedInput: {},
              extracted: {
                attachments: [],
                sanitizedResult: { status: 'executed' },
              },
              editedFiles: [],
              logRef: {
                logId: undefined,
                groupId: runTrace.trace.activeStageId(),
              },
            } as any,
          ],
        ),
      );

      const completedEvent = events.findLast(
        (event) => event.type === 'tool.end' && event.status === 'completed',
      );
      assert.ok(completedEvent, 'Tool completion event should be emitted');
      const logPayload =
        completedEvent?.type === 'tool.end'
          ? (completedEvent.result as Record<string, unknown>)
          : {};
      assert.equal(Object.hasOwn(logPayload, 'output'), false);

      const toolOutputMessage = messages.find(
        (msg) => (msg as any).type === 'function_call_output',
      ) as any;
      assert.equal(toolOutputMessage?.output, 'OK');
    } finally {
      unsubscribe();
      runTrace.dispose();
    }
  });

  it('keeps head and tail of an oversized command failure instead of discarding it', async () => {
    // Simulates a huge broken latexmk log: engine name up front, error detail
    // at the tail (where LaTeX/build errors cluster), filler in between.
    const hugeStderr =
      'ENGINE_HEADER '.repeat(400) +
      'x'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH) +
      'TAIL_ERROR_DETAIL '.repeat(5000);

    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: false,
      stdout: null,
      stderr: hugeStderr,
      timedOut: false,
      exitCode: 1,
    });

    const result = await new BashTool().call({ command: 'latexmk -pdf p.tex' });
    assert.equal(result.status, 'error');

    // This is exactly the choke point every model handler funnels through
    // before sending tool output back to the model.
    const text = formatToolResultAsText(result);
    assert.ok(
      text.includes('characters elided'),
      'Oversized result should be elided, not replaced wholesale',
    );
    assert.ok(!text.includes('was not included'));
    assert.ok(text.includes('ENGINE_HEADER'));
    assert.ok(text.includes('TAIL_ERROR_DETAIL'));
    assert.ok(!text.includes('x'.repeat(1000)));
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
    const options = roundServices({
      toolName: 'bash',
      logger: runTrace.trace,
      streamId: 'bash-tool' as StreamTabId,
      toolRegistry: new MapToolRegistry({ bash: bashTool }),
      checkInterruption: () => activeController?.signal.aborted ?? false,
      setAbortController: (controller) => {
        activeController = controller;
      },
    });

    const call = {
      provider: 'google',
      callId: 'bash-abort-1',
      name: 'bash',
      input: { command: 'echo long' },
      raw: { name: 'bash', args: { command: 'echo long' } },
    } as SdkToolCall;

    try {
      node.setServices(options);
      const result = await withTestRunContext(
        noopAgentRuntimeHost,
        'bash-tool',
        () => node.exec(call),
      );

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
