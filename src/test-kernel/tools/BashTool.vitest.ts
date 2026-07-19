// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports
import type { AgentEvent } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import {
  AgentWorkspaceState,
  FileInteractionState,
} from '@agent/core/state/AgentWorkspaceState';
import { ToolUseDispatchNode } from '@agent/core/flows/toolUseRound/ToolUseDispatchNode';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import { withToolEnvironment } from '@agent/followUp/ToolFileInteractionContext';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { MAX_TOOL_RESULT_TEXT_LENGTH } from '@agent/modelHandlers/contextManagementConstants';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import {
  EXECUTION_STATUS,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import type { ExecResult } from '@shared/schemas/opResults';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { BashTool } from '@tools/bash';
import { createRunTrace, StreamLogStore } from '@transcript';
import { TaskRunFileService } from '@utils/files';
import * as execUtils from '@utils/system/execUtils';

// Local file imports
import {
  createRecordingHost,
  recordSessionEvents,
  withTestRunContext,
} from '../agent/progressTestUtils';

// Third-party imports
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
      temperature: 0,
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
    client: {} as OpenAI,
    fileService: new TaskRunFileService('deadbeef'),
    toolRegistry: opts.toolRegistry,
    checkInterruption: opts.checkInterruption ?? (() => false),
    setAbortController: opts.setAbortController ?? (() => {}),
    onRoundFinalized: () => {},
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
      logger: createRunTrace('BashToolTest', StreamLogStore.ephemeral('test'))
        .trace,
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
    const runTrace = createRunTrace(
      'ToolStatusLogTest' as StreamTabId,
      StreamLogStore.ephemeral('test'),
    );
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

  it('preserves the first fatal error and the latest output for an oversized background run', async () => {
    // Simulates a multi-minute build whose first line is the fatal compiler
    // error and whose output keeps streaming well past the tail budget
    // (12,000 chars) before finishing — mirroring the scenario in #7145
    // where a long background run's early error was silently dropped once
    // the tail-only buffer rolled past it.
    const headMarker = 'FATAL: undefined reference to `compute` at build.c:12';
    const tailMarker = 'FATAL: link step failed, aborting build';
    const filler = 'x'.repeat(2000);
    const chunks = [
      `${headMarker}\n`,
      ...Array.from({ length: 8 }, () => filler),
      `${tailMarker}\n`,
    ];

    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      async (_command, options = {}) => {
        for (const chunk of chunks) {
          options.onStdout?.(chunk);
        }
        return {
          success: false,
          stdout: null,
          stderr: null,
          timedOut: false,
          exitCode: 1,
        };
      },
    );

    const sendFollowUpSpy = vi
      .spyOn(toolUseFollowUp, 'sendFollowUp')
      .mockResolvedValue({ status: 'sent' });

    const parentStreamId = 'bash-tool-bg-parent' as StreamTabId;
    const { host } = createRecordingHost();
    const bashTool = new BashTool();
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const launchResult = await withToolEnvironment(
        {
          run: { runtimeHost: host, streamId: parentStreamId },
          call: { tracker: new FileInteractionState() },
        },
        () =>
          bashTool.call({
            command: 'make build',
            run_in_background: true,
          }),
      );
      assert.equal(launchResult.status, 'executed');

      // The background run delivers its result asynchronously as a follow-up
      // once the (mocked) process settles.
      await vi.waitFor(() => {
        assert.ok(
          sendFollowUpSpy.mock.calls.length > 0,
          'Background bash should deliver a follow-up once the run completes',
        );
      });
    } finally {
      recorded.detach();
    }

    // sendFollowUp is overloaded (string | FollowUpQueueInput); bash.ts always
    // calls the object form, but Parameters<> on an overloaded function type
    // resolves to the last signature, so assert the concrete shape here.
    const followUpArg = sendFollowUpSpy.mock.calls[0]?.[1] as unknown as
      { text: string } | undefined;
    const deliveredText = followUpArg?.text;
    assert.ok(
      typeof deliveredText === 'string' && deliveredText.includes(headMarker),
      'Delivered follow-up should retain the first fatal error (head)',
    );
    assert.ok(
      typeof deliveredText === 'string' && deliveredText.includes(tailMarker),
      'Delivered follow-up should retain the most recent output (tail)',
    );
    assert.match(
      deliveredText ?? '',
      /<output-elided>[\d,]+ characters elided<\/output-elided>/,
      'Delivered follow-up should note how many characters sit between head and tail',
    );
  });

  it('wakes a WAITING parent stream when a background bash run completes', async () => {
    // Regression: background bash delivery used a bespoke sendFollowUp call
    // with no wake step, so a parent suspended WAITING on the job never
    // resumed — every other child-run type routes through the shared
    // wake-aware deliverChildRunFollowUp path. Prove the wake actually fires
    // by asserting the host resume port gets invoked once the run completes.
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: 'done\n',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });

    const parentStreamId = 'bash-tool-bg-wake-parent' as StreamTabId;
    const tryResumeStream = vi.fn().mockResolvedValue(true);
    await installPlatform(
      {
        workspacePath: '/workspace',
        config: { 'texra.toolUse.requireBashApproval': false },
      },
      { agentResume: { tryResumeStream } },
    );
    seedStreamStatusForTest(
      defaultSession().status,
      parentStreamId,
      STREAM_STATUS.WAITING,
    );

    const { host } = createRecordingHost();
    const bashTool = new BashTool();
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const launchResult = await withToolEnvironment(
        {
          run: { runtimeHost: host, streamId: parentStreamId },
          call: { tracker: new FileInteractionState() },
        },
        () =>
          bashTool.call({
            command: 'make build',
            run_in_background: true,
          }),
      );
      assert.equal(launchResult.status, 'executed');

      // The background run's completion must queue the follow-up AND wake
      // the WAITING parent through the host resume port — not just queue it
      // for the parent to notice on its own.
      await vi.waitFor(() => {
        assert.ok(
          tryResumeStream.mock.calls.length > 0,
          'Background bash completion should wake the WAITING parent stream',
        );
      });
      assert.equal(tryResumeStream.mock.calls[0]?.[0], parentStreamId);
    } finally {
      recorded.detach();
      clearStreamStatusForTest(defaultSession().status, parentStreamId);
      defaultSession().followUps.release(parentStreamId);
    }
  });

  it('#8093 regression: finalizes the background execution before its wake step resolves, so a resumed parent never self-stalls waiting on it', async () => {
    // Regression: waking a WAITING parent (`agentResume.tryResumeStream`) can
    // await the ENTIRE resumed parent turn. If that wake were awaited before
    // this execution's own finalize (as it used to be, delivering via a
    // single wake-aware call before `finalizeBackground`), a resumed parent
    // that immediately calls `executions` with action=wait on this same
    // execution could find it still RUNNING and block on itself for the
    // whole wait budget. Prove the ordering: hold the host resume port open
    // and confirm the execution is already untracked (terminal) by the time
    // that port is even invoked.
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: 'done\n',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });

    const parentStreamId = 'bash-tool-bg-finalize-before-wake' as StreamTabId;
    let releaseResume: (() => void) | undefined;
    let handleAtResumeTime: unknown;
    let executionId = '';
    const tryResumeStream = vi.fn().mockImplementation(async () => {
      handleAtResumeTime = defaultSession().executions.getHandle(executionId);
      await new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
      return true;
    });
    await installPlatform(
      {
        workspacePath: '/workspace',
        config: { 'texra.toolUse.requireBashApproval': false },
      },
      { agentResume: { tryResumeStream } },
    );
    seedStreamStatusForTest(
      defaultSession().status,
      parentStreamId,
      STREAM_STATUS.WAITING,
    );

    const { host } = createRecordingHost();
    const bashTool = new BashTool();
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const launchResult = await withToolEnvironment(
        {
          run: { runtimeHost: host, streamId: parentStreamId },
          call: { tracker: new FileInteractionState() },
        },
        () =>
          bashTool.call({
            command: 'make build',
            run_in_background: true,
          }),
      );
      assert.equal(launchResult.status, 'executed');
      const executionIdMatch = /Execution ID: (\S+)/.exec(
        String(launchResult.output ?? ''),
      );
      assert.ok(
        executionIdMatch,
        'Launch output should report an execution id',
      );
      executionId = executionIdMatch![1]!;

      await vi.waitFor(() => {
        assert.ok(
          tryResumeStream.mock.calls.length > 0,
          'Background bash completion should reach the wake step',
        );
      });
      // The wake step was reached — this execution must already be untracked
      // (finalized), never still RUNNING, so a resumed parent that waits on
      // it right now resolves immediately instead of racing its own wake.
      assert.equal(handleAtResumeTime, undefined);
      assert.equal(
        defaultSession().executions.getHandle(executionId),
        undefined,
      );
    } finally {
      releaseResume?.();
      recorded.detach();
      clearStreamStatusForTest(defaultSession().status, parentStreamId);
      defaultSession().followUps.release(parentStreamId);
    }
  });

  it('finalizes background execution when supplementary result metadata fails', async () => {
    let resolveCommand: ((result: ExecResult) => void) | undefined;
    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );
    await installPlatform({
      workspacePath: '/workspace',
      config: { 'texra.toolUse.requireBashApproval': false },
    });
    const parentStreamId = 'bash-result-meta-failure' as StreamTabId;
    const { host } = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession().events);

    const launchResult = await withToolEnvironment(
      {
        run: { runtimeHost: host, streamId: parentStreamId },
        call: { tracker: new FileInteractionState() },
      },
      () =>
        new BashTool().call({
          command: 'make build',
          run_in_background: true,
        }),
    );
    const executionId = /Execution ID: (\S+)/.exec(
      String(launchResult.output ?? ''),
    )?.[1];
    assert.ok(executionId, JSON.stringify(launchResult));
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'writeResultMeta').mockRejectedValueOnce(
      new Error('result metadata disk full'),
    );

    resolveCommand?.({
      success: true,
      stdout: 'done\n',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });

    await vi.waitFor(async () => {
      assert.equal(
        (await store.readMeta())?.terminalStatus,
        EXECUTION_STATUS.COMPLETED,
      );
    });
    recorded.detach();
    defaultSession().followUps.release(parentStreamId);
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

    const runTrace = createRunTrace(
      'BashToolAbortTest' as StreamTabId,
      StreamLogStore.ephemeral('test'),
    );
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
