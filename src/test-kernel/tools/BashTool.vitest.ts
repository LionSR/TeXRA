// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports
import type { AgentEvent } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import {
  AgentWorkspaceState,
  FileInteractionState,
} from '@agent/core/state/AgentWorkspaceState';
import { ToolUseDispatchNode } from '@agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode';
import { createToolUseRoundFlow } from '@agent/implementations/flows/tooluse/ToolUseRoundFlow';
import type { ToolUseRoundShared } from '@agent/implementations/flows/tooluse/toolUseRound/roundShared';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import { withToolEnvironment } from '@agent/followUp/ToolFileInteractionContext';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { MAX_TOOL_RESULT_TEXT_LENGTH } from '@agent/modelHandlers/contextManagementConstants';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecResult,
  type StreamTabId,
  type ToolResult,
  AgentCategory,
} from '@shared/schemas';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { BashTool } from '@tools/bash';
import * as bashDelivery from '@tools/delegation/bashDelivery';
import { createRunTrace, StreamLogStore } from '@transcript';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import * as execUtils from '@utils/system/execUtils';

// Local file imports
import { testModelCell } from '../agent/modelCellTestUtils';
import {
  recordSessionEvents,
  testRunScope,
  withTestRunContext,
} from '../agent/progressTestUtils';

// Third-party type-only import (import/order places it last)
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
  abortSignal?: AbortSignal;
}): ToolUseRoundServices<OpenAI> {
  return {
    runScope: testRunScope(opts.streamId, { signal: opts.abortSignal }),
    modelCell: testModelCell(new BashMockHandler(testModelConfig)),
    config: testModelConfig as any,
    setting: {
      agentCategory: AgentCategory.ToolUse,
      temperature: 0,
      requiredFilesInternal: {},
      defaultOutputFiles: [],
      tools: [{ name: opts.toolName }],
    } satisfies AgentSetting,
    prompt: {
      systemPrompt: '',
      userPrefix: '',
      userRequest: '',
    } satisfies AgentPrompt,
    userVarChannels: { input: {}, transient: {} },
    toolPolicy: createToolPolicy(),
    logger: opts.logger,
    fileService: new TaskRunFileService('deadbeef'),
    toolRegistry: opts.toolRegistry,
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

type ExecuteCommandOptions = NonNullable<
  Parameters<typeof execUtils.executeCommand>[1]
>;

/**
 * Stub `executeCommand` so it emits streamed chunks through the callbacks the
 * tool passes in, then settles with a successful zero-exit result unless the
 * case overrides part of it.
 */
function mockStreamingCommand(
  stream: (options: ExecuteCommandOptions) => void,
  result: Partial<ExecResult> = {},
): void {
  vi.spyOn(execUtils, 'executeCommand').mockImplementation(
    async (_command, options = {}) => {
      stream(options);
      return {
        success: true,
        stdout: '',
        stderr: '',
        timedOut: false,
        exitCode: 0,
        ...result,
      };
    },
  );
}

/** The successful zero-exit result most background-launch cases settle with. */
const DONE_EXEC_RESULT: ExecResult = {
  success: true,
  stdout: 'done\n',
  stderr: '',
  timedOut: false,
  exitCode: 0,
};

/**
 * Stub `executeCommand` to park on a promise the test resolves manually.
 * Returns the resolver so the case can interleave assertions before the
 * (mocked) process settles.
 */
function holdCommand(): (result: ExecResult) => void {
  let resolve: ((result: ExecResult) => void) | undefined;
  vi.spyOn(execUtils, 'executeCommand').mockImplementation(
    () =>
      new Promise((resolvePromise) => {
        resolve = resolvePromise;
      }),
  );
  return (result) => resolve?.(result);
}

/** Shared teardown for background-launch cases. */
function detachBackgroundRun(
  recorded: ReturnType<typeof recordSessionEvents>,
  parentStreamId: StreamTabId,
  streamToClear?: StreamTabId,
): void {
  recorded.detach();
  if (streamToClear) {
    clearStreamStatusForTest(defaultSession().status, streamToClear);
  }
  defaultSession().followUps.terminalize(parentStreamId);
}

// Unit tests exercise the tool directly — no approval host is wired.
const BASH_PLATFORM_OPTIONS = {
  workspacePath: '/workspace',
  config: { 'texra.toolUse.requireBashApproval': false },
} as const;

/** The execution and child-stream ids a background launch reports in its output. */
function launchedIds(result: ToolResult): {
  output: string;
  executionId: string | undefined;
  childStreamId: StreamTabId | undefined;
} {
  const output = String(result.output ?? '');
  return {
    output,
    executionId: /Execution ID: (\S+)/.exec(output)?.[1],
    childStreamId: /Stream tab: (\S+)/.exec(output)?.[1] as
      StreamTabId | undefined,
  };
}

function launchBackgroundBash(
  parentStreamId: StreamTabId,
): Promise<ToolResult> {
  return withToolEnvironment(
    {
      run: { streamId: parentStreamId, session: defaultSession() },
      call: { tracker: new FileInteractionState() },
    },
    () =>
      new BashTool().call({
        command: 'make build',
        run_in_background: true,
      }),
  );
}

describe('BashTool', () => {
  setupPlatform(BASH_PLATFORM_OPTIONS);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves long stdout for tool results and model payloads', async () => {
    const longOutput = '0123456789'.repeat(35); // 350 chars, exceeds log truncation of 150
    const execResult: ExecResult = {
      success: true,
      // executeCommand trims trailing whitespace before returning stdout
      stdout: `${longOutput}\n`.trim(),
      stderr: '',
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

    const flow = createToolUseRoundFlow();
    flow.setServices(options);
    await withTestRunContext(options.runScope, () => flow.run(shared));

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

  it.each([
    { name: '50,000 characters', text: 'a'.repeat(50_000) },
    { name: '50,001 characters', text: 'b'.repeat(50_001) },
    { name: '52,000 characters', text: 'c'.repeat(52_000) },
    { name: 'exactly 54,000 characters', text: 'd'.repeat(54_000) },
  ])('reconstructs $name exactly without a marker', async ({ text }) => {
    mockStreamingCommand((options) => {
      options.onStdout?.(text.slice(0, 777));
      options.onStdout?.(text.slice(777));
    });

    const result = await new BashTool().call({ command: 'boundary-output' });
    assert.equal(result.output, text);
    assert.ok(!String(result.output).includes('characters elided'));
  });

  it('marks exactly one character elided at 54,001 normalized characters', async () => {
    const text = 'h'.repeat(4_000) + 'X' + 't'.repeat(50_000);
    mockStreamingCommand((options) => options.onStdout?.(text));

    const result = await new BashTool().call({ command: 'one-elided' });
    assert.equal(
      result.output,
      `${'h'.repeat(4_000)}\n\n[... 1 characters elided from stdout ...]\n\n${'t'.repeat(50_000)}`,
    );
  });

  it.each([
    {
      name: 'leading and trailing whitespace',
      chunks: [' \t\n'.repeat(40_000), '  body', '  ', '\r\n'.repeat(40_000)],
      expected: 'body',
    },
    {
      name: 'all whitespace',
      chunks: [' \t\n'.repeat(40_000), '\r\n'.repeat(40_000)],
      expected: '',
    },
    {
      name: 'internal whitespace',
      chunks: ['  alpha', ' '.repeat(20_000), 'omega  '],
      expected: `alpha${' '.repeat(20_000)}omega`,
    },
  ])('matches full-stream trim for $name', async ({ chunks, expected }) => {
    mockStreamingCommand((options) => {
      for (const chunk of chunks) options.onStdout?.(chunk);
    });

    const result = await new BashTool().call({ command: 'whitespace-output' });
    assert.equal(result.output, expected);
  });

  it('counts only normalized internal whitespace as elided', async () => {
    const internalWhitespace = ' '.repeat(60_000);
    mockStreamingCommand((options) => {
      options.onStdout?.(`  A${internalWhitespace}`);
      options.onStdout?.(`B${' '.repeat(100_000)}`);
    });

    const result = await new BashTool().call({ command: 'whitespace-gap' });
    const output = String(result.output);
    assert.ok(
      output.includes(
        `[... ${(6_002).toLocaleString()} characters elided from stdout ...]`,
      ),
    );
    assert.ok(output.startsWith(`A${' '.repeat(3_999)}`));
    assert.ok(output.endsWith(`${' '.repeat(49_999)}B`));
  });

  it.each([
    {
      name: 'head boundary',
      text: `${'a'.repeat(3_999)}🙂${'b'.repeat(60_000)}`,
    },
    {
      name: 'tail boundary',
      text: `${'a'.repeat(4_001)}🙂${'b'.repeat(50_000)}`,
    },
  ])('does not split surrogate pairs at the $name', async ({ text }) => {
    mockStreamingCommand((options) => options.onStdout?.(text));

    const result = await new BashTool().call({ command: 'unicode-boundary' });
    const output = String(result.output);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(output));
    assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(output));
  });

  it('incrementally retains bounded head and tail stdout across Unicode chunk boundaries', async () => {
    const headMarker = 'HEAD🙂';
    const tailMarker = 'TAIL🙂';
    const emoji = '🙂';

    mockStreamingCommand((options) => {
      assert.equal(options.buffer, false);
      options.onStdout?.(`HEAD${emoji[0]}`);
      options.onStdout?.(`${emoji[1]}\n`);
      options.onStdout?.('x'.repeat(100_000));
      options.onStdout?.(`\n${tailMarker}\n`);
    });

    const result = await new BashTool().call({ command: 'large-output' });
    assert.equal(result.status, 'executed');
    const output = String(result.output);
    assert.ok(output.startsWith(headMarker));
    assert.ok(output.endsWith(tailMarker));
    assert.match(output, /characters elided from stdout/);
    assert.ok(!output.includes('x'.repeat(60_000)));
    assert.ok(!output.includes('\ufffd'));
    assert.ok(output.length < 55_000);
  });

  it('keeps bounded stderr and stdout separate and ordered on large failures', async () => {
    mockStreamingCommand(
      (options) => {
        options.onStdout?.('STDOUT_HEAD\n');
        options.onStdout?.('o'.repeat(100_000));
        options.onStdout?.('\nSTDOUT_TAIL');
        options.onStderr?.('STDERR_HEAD\n');
        options.onStderr?.('e'.repeat(100_000));
        options.onStderr?.('\nSTDERR_TAIL');
      },
      { success: false, exitCode: 9 },
    );

    const result = await new BashTool().call({ command: 'large-failure' });
    assert.equal(result.status, 'error');
    const error = result.error ?? '';
    assert.ok(error.includes('STDERR_HEAD'));
    assert.ok(error.includes('STDERR_TAIL'));
    assert.ok(error.includes('characters elided from stderr'));
    assert.ok(error.includes('STDOUT_HEAD'));
    assert.ok(error.includes('STDOUT_TAIL'));
    assert.ok(error.includes('characters elided from stdout'));
    assert.ok(error.indexOf('STDERR_HEAD') < error.indexOf('STDOUT_HEAD'));
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
      await withTestRunContext(options.runScope, () =>
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

    mockStreamingCommand((options) => options.onStderr?.(hugeStderr), {
      success: false,
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

    mockStreamingCommand(
      (options) => {
        for (const chunk of chunks) {
          options.onStdout?.(chunk);
        }
      },
      { success: false, exitCode: 1 },
    );

    const submitFollowUpSpy = vi
      .spyOn(toolUseFollowUp, 'submitFollowUp')
      .mockResolvedValue({ status: 'sent' });

    const parentStreamId = 'bash-tool-bg-parent' as StreamTabId;
    const parentLease = defaultSession().followUps.claimLive(
      parentStreamId,
      'flow',
    )!;
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const launchResult = await launchBackgroundBash(parentStreamId);
      assert.equal(launchResult.status, 'executed');

      // The background run delivers its result asynchronously as a follow-up
      // once the (mocked) process settles.
      await vi.waitFor(() => {
        assert.ok(
          submitFollowUpSpy.mock.calls.length > 0,
          'Background bash should deliver a follow-up once the run completes',
        );
      });
    } finally {
      recorded.detach();
      defaultSession().followUps.release(parentLease, 'terminal');
    }

    expect(submitFollowUpSpy.mock.calls[0]?.[2]?.expectedGenerationId).toBe(
      parentLease.generationId,
    );

    const followUpArg = submitFollowUpSpy.mock.calls[0]?.[1];
    const deliveredText =
      typeof followUpArg === 'string' ? followUpArg : followUpArg?.text;
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
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue(DONE_EXEC_RESULT);

    const parentStreamId = 'bash-tool-bg-wake-parent' as StreamTabId;
    const tryResumeStream = vi.fn().mockResolvedValue(true);
    await installPlatform(BASH_PLATFORM_OPTIONS, {
      agentResume: { tryResumeStream },
    });
    seedStreamStatusForTest(defaultSession().status, parentStreamId, {
      phase: STREAM_PHASE.WAITING,
    });

    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const launchResult = await launchBackgroundBash(parentStreamId);
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
      detachBackgroundRun(recorded, parentStreamId, parentStreamId);
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
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue(DONE_EXEC_RESULT);

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
    await installPlatform(BASH_PLATFORM_OPTIONS, {
      agentResume: { tryResumeStream },
    });
    seedStreamStatusForTest(defaultSession().status, parentStreamId, {
      phase: STREAM_PHASE.WAITING,
    });

    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const launchResult = await launchBackgroundBash(parentStreamId);
      assert.equal(launchResult.status, 'executed');
      const launched = launchedIds(launchResult);
      assert.ok(
        launched.executionId,
        'Launch output should report an execution id',
      );
      executionId = launched.executionId;

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
      detachBackgroundRun(recorded, parentStreamId, parentStreamId);
    }
  });

  it('finalizes background execution when supplementary result metadata fails', async () => {
    const resolveCommand = holdCommand();
    await installPlatform(BASH_PLATFORM_OPTIONS);
    const parentStreamId = 'bash-result-meta-failure' as StreamTabId;
    const recorded = recordSessionEvents(defaultSession().events);

    const launchResult = await launchBackgroundBash(parentStreamId);
    const { executionId } = launchedIds(launchResult);
    assert.ok(executionId, JSON.stringify(launchResult));
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'writeResultMeta').mockRejectedValueOnce(
      new Error('result metadata disk full'),
    );

    resolveCommand(DONE_EXEC_RESULT);

    await vi.waitFor(async () => {
      assert.equal((await store.readMeta())?.outcome, RUN_OUTCOME.COMPLETED);
    });
    detachBackgroundRun(recorded, parentStreamId);
  });

  it('finalizes the background child when the completion path throws before its normal finalize', async () => {
    // Nothing else finalizes a background child: before the latch, an
    // unexpected throw on the completion path left the child stream RUNNING
    // forever, with its interrupt handler still attached to a dead process.
    const resolveCommand = holdCommand();
    vi.spyOn(bashDelivery, 'formatBashDelivery').mockImplementation(() => {
      throw new Error('delivery formatting blew up');
    });
    await installPlatform(BASH_PLATFORM_OPTIONS);
    const parentStreamId = 'bash-completion-path-throw' as StreamTabId;
    const recorded = recordSessionEvents(defaultSession().events);

    const launchResult = await launchBackgroundBash(parentStreamId);
    const { output, executionId, childStreamId } = launchedIds(launchResult);
    assert.ok(executionId, output);
    assert.ok(childStreamId, output);

    resolveCommand(DONE_EXEC_RESULT);

    await vi.waitFor(() => {
      assert.equal(
        defaultSession().status.get(childStreamId),
        STREAM_PHASE.FAILED,
      );
    });
    assert.equal(defaultSession().executions.getHandle(executionId), undefined);

    detachBackgroundRun(recorded, parentStreamId, childStreamId);
  });

  it('persists a killed background command as interrupted, not failed', async () => {
    const resolveCommand = holdCommand();
    await installPlatform(BASH_PLATFORM_OPTIONS);
    const parentStreamId = 'bash-killed-background' as StreamTabId;
    const recorded = recordSessionEvents(defaultSession().events);

    const launchResult = await launchBackgroundBash(parentStreamId);
    const { output, executionId, childStreamId } = launchedIds(launchResult);
    assert.ok(executionId, output);
    assert.ok(childStreamId, output);

    // The user stop lands CANCELLED on the stream phase; only afterwards does
    // the killed process report its non-zero exit.
    assert.equal(defaultSession().executions.kill(executionId), true);
    assert.equal(
      defaultSession().status.get(childStreamId),
      STREAM_PHASE.CANCELLED,
    );
    resolveCommand({
      success: false,
      stdout: '',
      stderr: 'Terminated\n',
      timedOut: false,
      exitCode: 143,
    });

    const store = getExecutionStore(executionId);
    await vi.waitFor(async () => {
      assert.equal((await store.readMeta())?.outcome, RUN_OUTCOME.CANCELLED);
    });
    detachBackgroundRun(recorded, parentStreamId, childStreamId);
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

  it('keeps bounded streamed stdout and stderr in timeout feedback', async () => {
    mockStreamingCommand(
      (options) => {
        options.onStdout?.(`STDOUT_HEAD${'o'.repeat(100_000)}STDOUT_TAIL`);
        options.onStderr?.(`STDERR_HEAD${'e'.repeat(100_000)}STDERR_TAIL`);
      },
      { success: false, timedOut: true, exitCode: 1 },
    );

    const result = await new BashTool().call({
      command: 'slow-command',
      timeout: 1_000,
    });
    assert.equal(result.status, 'error');
    const error = result.error ?? '';
    assert.ok(error.startsWith('Foreground command timed out after 1s.'));
    assert.match(
      error,
      /<stdout>STDOUT_HEAD[\s\S]*characters elided from stdout[\s\S]*STDOUT_TAIL<\/stdout>/,
    );
    assert.match(
      error,
      /<stderr>STDERR_HEAD[\s\S]*characters elided from stderr[\s\S]*STDERR_TAIL<\/stderr>/,
    );
    assert.ok(error.includes('run_in_background: true'));
  });

  it('finalizes deferred progress card when foreground bash is aborted', async () => {
    const runController = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    mockStreamingCommand(
      (options) => {
        receivedSignal = options.signal;
        options.onStdout?.('started\n');
        runController.abort();
      },
      {
        success: false,
        stderr: 'Command aborted by user',
        exitCode: 130,
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
      abortSignal: runController.signal,
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
      const result = await withTestRunContext(options.runScope, () =>
        node.exec(call),
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
