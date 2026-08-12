import { strict as assert } from 'node:assert';

import { describe, it, beforeAll } from 'vitest';

import { ToolUseDispatchNode } from '@agent/core/flows/toolUseRound/ToolUseDispatchNode';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { StreamTabId } from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { installPlatform } from '@test/support/setupPlatform';
import { createRunTrace, StreamLogStore } from '@transcript';
import { delay } from '@utils/core';

import { testRunScope, withTestRunContext } from './progressTestUtils';
import { testModelCell } from './modelCellTestUtils';

interface DispatchProbe {
  events: string[];
  inFlight: number;
  maxInFlight: number;
}

function newProbe(): DispatchProbe {
  return { events: [], inFlight: 0, maxInFlight: 0 };
}

function probeTool(
  probe: DispatchProbe,
  name: string,
  delayMs: number,
  options: { endTurn?: boolean; parallelSafe?: boolean } = {},
): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    parallelSafe: options.parallelSafe,
    async call(input: unknown): Promise<ToolResult> {
      const tag = `${name}:${JSON.stringify(input)}`;
      probe.events.push(`start ${tag}`);
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      await delay(delayMs);
      probe.inFlight -= 1;
      probe.events.push(`end ${tag}`);
      return {
        status: 'executed',
        output: `${tag} ok`,
        endTurn: options.endTurn,
      };
    },
  } as ITool;
}

function makeCall(
  callId: string,
  name: string,
  input: Record<string, unknown>,
): SdkToolCall {
  return {
    provider: 'openai',
    callId,
    name,
    input,
    raw: {},
  } as unknown as SdkToolCall;
}

interface HarnessOptions {
  tools: Record<string, ITool>;
  rootUserInstruction?: string;
  /** The run's one interrupt signal; defaults to a run nobody interrupts. */
  abortSignal?: AbortSignal;
  modelHandlerOverrides?: Record<string, unknown>;
  runClient?: unknown;
}

function dispatchHarness(opts: HarnessOptions) {
  const runTrace = createRunTrace(
    'DispatchParallelTest' as StreamTabId,
    StreamLogStore.ephemeral('test'),
  );
  const services = {
    config: AgentConfigSchema.parse({
      rootUserInstruction: opts.rootUserInstruction,
    }),
    logger: runTrace.trace,
    toolRegistry: new MapToolRegistry(opts.tools),
    runScope: testRunScope('dispatch-parallel', {
      signal: opts.abortSignal,
    }),
    onRoundFinalized: () => {},
    modelCell: testModelCell({
      requiresBatchedParallelToolResults: false,
      createToolUseFollowUpMessages: async () => [],
      getClient: async () => opts.runClient ?? {},
      ...opts.modelHandlerOverrides,
    }),
    run: AgentRunStateSnapshotSchema.parse({}),
    workspace: AgentWorkspaceState.create(),
  } as unknown as ToolUseRoundServices<unknown>;
  const node = new ToolUseDispatchNode<unknown>();
  node.setServices(services);
  return { node, trace: runTrace.trace, dispose: () => runTrace.dispose() };
}

type DispatchHarness = ReturnType<typeof dispatchHarness>;

/** Run `fn` with a dispatch harness that is always disposed afterwards. */
async function withDispatchHarness<T>(
  opts: HarnessOptions,
  fn: (harness: DispatchHarness) => Promise<T>,
): Promise<T> {
  const harness = dispatchHarness(opts);
  try {
    return await fn(harness);
  } finally {
    harness.dispose();
  }
}

interface DispatchInternals {
  prep(shared: unknown): Promise<SdkToolCall[]>;
  _exec(items: unknown[]): Promise<unknown[]>;
  post(
    shared: unknown,
    dispatched: SdkToolCall[],
    results: unknown[],
  ): Promise<string | undefined>;
}

function internals(node: ToolUseDispatchNode<unknown>): DispatchInternals {
  return node as unknown as DispatchInternals;
}

function execPrepped(
  node: ToolUseDispatchNode<unknown>,
  prepped: SdkToolCall[],
): Promise<unknown[]> {
  return withTestRunContext(node.services.runScope, () =>
    internals(node)._exec(prepped),
  );
}

/** prep() then the batch executor, mirroring Node's _run sequence. */
async function runDispatch(
  node: ToolUseDispatchNode<unknown>,
  calls: SdkToolCall[],
  currentUserInstruction?: string,
): Promise<unknown[]> {
  const prepped = await internals(node).prep({
    toolCalls: calls,
    shouldStop: false,
    messages: [],
    currentUserInstruction,
  });
  return execPrepped(node, prepped);
}

function countStarts(probe: DispatchProbe, toolName = ''): number {
  return probe.events.filter((event) => event.startsWith(`start ${toolName}`))
    .length;
}

type ExecResult = {
  call: SdkToolCall;
  result: ToolResult;
  editedFiles: unknown[];
} | null;

/** The duplicate inherits the primary's output, not a synthetic error. */
function assertDuplicateInheritsOutput(results: ExecResult[]): void {
  const primary = results[0]?.result;
  const duplicate = results[1]?.result;
  assert.equal(duplicate?.status, 'executed');
  assert.equal(
    duplicate?.status === 'executed' ? duplicate.output : undefined,
    primary?.status === 'executed' ? primary.output : 'missing',
  );
}

describe('ToolUseDispatchNode parallel dispatch', () => {
  beforeAll(() => installPlatform({ workspacePath: '/workspace' }));

  it('preserves the unwrapped root instruction across nested delegation', async () => {
    let observedInstruction: string | undefined;
    let observedTrace: unknown;
    const inspectContext: ITool = {
      definition: {
        name: 'inspect_context',
        description: 'inspect_context',
        parameters: {},
      },
      async call(): Promise<ToolResult> {
        const context = getCurrentToolCallContext();
        observedInstruction = context?.userInstruction;
        observedTrace = context?.trace;
        return { status: 'executed', output: 'ok' };
      },
    } as ITool;

    await withDispatchHarness(
      {
        tools: { inspect_context: inspectContext },
        rootUserInstruction: 'Do not use files or external tools.',
      },
      async ({ node, trace }) => {
        await runDispatch(
          node,
          [makeCall('c1', 'inspect_context', {})],
          'Wrapped child instruction with prior handoff boilerplate.',
        );
        assert.equal(
          observedInstruction,
          'Do not use files or external tools.',
        );
        assert.equal(observedTrace, trace);
      },
    );
  });

  it('executes contiguous parallel-safe calls concurrently, preserving order', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: {
          grep: probeTool(probe, 'grep', 25, { parallelSafe: true }),
          read_file: probeTool(probe, 'read_file', 25, { parallelSafe: true }),
        },
      },
      async ({ node }) => {
        const results = (await runDispatch(node, [
          makeCall('c1', 'grep', { pattern: 'a' }),
          makeCall('c2', 'read_file', { path: 'b' }),
        ])) as ExecResult[];

        assert.equal(probe.maxInFlight, 2, 'safe calls should overlap');
        assert.equal(results.length, 2);
        assert.equal(results[0]?.call.callId, 'c1');
        assert.equal(results[1]?.call.callId, 'c2');
        assert.equal(results[0]?.result.status, 'executed');
        assert.equal(results[1]?.result.status, 'executed');
      },
    );
  });

  it('passes the run-bound client to batched follow-up construction', async () => {
    const probe = newProbe();
    const runClient = { route: 'personal' };
    let receivedClient: unknown;
    await withDispatchHarness(
      {
        tools: {
          grep: probeTool(probe, 'grep', 0, { parallelSafe: true }),
        },
        runClient,
        modelHandlerOverrides: {
          requiresBatchedParallelToolResults: true,
          createBatchedToolUseFollowUpMessages: async (
            _entries: unknown,
            _workspace: unknown,
            _text: unknown,
            client: unknown,
          ) => {
            receivedClient = client;
            return [];
          },
        },
      },
      async ({ node }) => {
        const calls = [
          makeCall('c1', 'grep', { pattern: 'a' }),
          makeCall('c2', 'grep', { pattern: 'b' }),
        ];
        const shared = { toolCalls: calls, shouldStop: false, messages: [] };

        const prepped = await internals(node).prep(shared);
        const results = await execPrepped(node, prepped);
        await internals(node).post(shared, prepped, results);

        assert.equal(receivedClient, runClient);
      },
    );
  });

  it('treats non-safe tools as ordering barriers', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: {
          read_file: probeTool(probe, 'read_file', 20, { parallelSafe: true }),
          write_file: probeTool(probe, 'write_file', 10),
        },
      },
      async ({ node }) => {
        await runDispatch(node, [
          makeCall('c1', 'read_file', { n: 1 }),
          makeCall('c2', 'write_file', { n: 2 }),
          makeCall('c3', 'read_file', { n: 3 }),
        ]);

        assert.equal(probe.maxInFlight, 1, 'barrier should force sequential');
        assert.deepEqual(probe.events, [
          'start read_file:{"n":1}',
          'end read_file:{"n":1}',
          'start write_file:{"n":2}',
          'end write_file:{"n":2}',
          'start read_file:{"n":3}',
          'end read_file:{"n":3}',
        ]);
      },
    );
  });

  it('stops dispatch and ends the turn after a terminal result', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: {
          submit_output: probeTool(probe, 'submit_output', 0, {
            endTurn: true,
          }),
          write_file: probeTool(probe, 'write_file', 0),
        },
      },
      async ({ node }) => {
        const calls = [
          makeCall('c1', 'submit_output', { title: 'done' }),
          makeCall('c2', 'write_file', { path: 'late.txt' }),
        ];
        const shared = {
          toolCalls: calls,
          shouldStop: false,
          endTurn: false,
          messages: [],
        };

        const prepped = await internals(node).prep(shared);
        const results = await execPrepped(node, prepped);
        const transition = await internals(node).post(shared, prepped, results);

        assert.deepEqual(probe.events, [
          'start submit_output:{"title":"done"}',
          'end submit_output:{"title":"done"}',
        ]);
        assert.equal(shared.shouldStop, true);
        assert.equal(shared.endTurn, true);
        assert.equal(transition, FlowTransition.COMPLETE);
      },
    );
  });

  it('executes duplicate parallel calls once and fans the result out', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: { grep: probeTool(probe, 'grep', 5, { parallelSafe: true }) },
      },
      async ({ node }) => {
        const results = (await runDispatch(node, [
          makeCall('c1', 'grep', { pattern: 'same' }),
          makeCall('c2', 'grep', { pattern: 'same' }),
          makeCall('c3', 'grep', { pattern: 'other' }),
        ])) as ExecResult[];

        assert.equal(
          countStarts(probe),
          2,
          'duplicate must not execute the tool again',
        );
        assert.equal(results[1]?.call.callId, 'c2');
        assertDuplicateInheritsOutput(results);
        assert.deepEqual(
          results[1]?.editedFiles,
          [],
          'duplicate must not re-track edits',
        );
        assert.deepEqual(
          (results[1] as { extracted?: { attachments: unknown[] } })?.extracted
            ?.attachments,
          [],
          'duplicate must not re-inject the primary attachments',
        );
      },
    );
  });

  it('cancels every concurrent call from the one run signal', async () => {
    const probe = newProbe();
    const runController = new AbortController();
    await withDispatchHarness(
      {
        tools: {
          grep: probeTool(probe, 'grep', 60, { parallelSafe: true }),
          read_file: probeTool(probe, 'read_file', 60, { parallelSafe: true }),
        },
        abortSignal: runController.signal,
      },
      async ({ node }) => {
        const pending = runDispatch(node, [
          makeCall('c1', 'grep', { pattern: 'a' }),
          makeCall('c2', 'read_file', { path: 'b' }),
        ]);
        await delay(15);
        assert.equal(probe.maxInFlight, 2, 'both calls should be in flight');
        runController.abort();

        const results = (await pending) as ExecResult[];
        assert.deepEqual(
          results,
          [null, null],
          'aborted concurrent calls should resolve to null',
        );
      },
    );
  });

  it('does not share read results across a mutating barrier', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: {
          read_file: probeTool(probe, 'read_file', 5, { parallelSafe: true }),
          write_file: probeTool(probe, 'write_file', 5),
        },
      },
      async ({ node }) => {
        const results = (await runDispatch(node, [
          makeCall('c1', 'read_file', { path: 'x' }),
          makeCall('c2', 'write_file', { path: 'x', content: 'new' }),
          makeCall('c3', 'read_file', { path: 'x' }),
        ])) as ExecResult[];

        // The post-barrier read must execute again — the write may have
        // changed what it returns, so sharing the pre-barrier result would
        // feed the model stale contents.
        assert.equal(
          countStarts(probe, 'read_file'),
          2,
          'read after a barrier must re-execute',
        );
        assert.equal(results[2]?.result.status, 'executed');
      },
    );
  });

  it('leaves side-effect duplicates cancelled when their primary never ran', async () => {
    const probe = newProbe();
    const runController = new AbortController();
    await withDispatchHarness(
      {
        tools: { write_file: probeTool(probe, 'write_file', 5) },
        abortSignal: runController.signal,
      },
      async ({ node }) => {
        const calls = [
          makeCall('c1', 'write_file', { path: 'a', content: 'x' }),
          makeCall('c2', 'write_file', { path: 'a', content: 'x' }),
        ];
        const shared = { toolCalls: calls, shouldStop: false, messages: [] };
        const prepped = await internals(node).prep(shared);
        // Interrupt lands after planning but before anything executes.
        runController.abort();
        const results = (await execPrepped(node, prepped)) as ExecResult[];

        assert.equal(probe.events.length, 0, 'nothing should execute');
        // The duplicate stays cancelled with its primary — no synthetic
        // success when no effect happened at all.
        assert.deepEqual(results, [null, null]);
      },
    );
  });

  it('allows an identical mutation again after a different mutation', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: {
          write_file: probeTool(probe, 'write_file', 5),
          edit_file: probeTool(probe, 'edit_file', 5),
        },
      },
      async ({ node }) => {
        const results = (await runDispatch(node, [
          makeCall('c1', 'write_file', { path: 'x', content: 'v1' }),
          makeCall('c2', 'edit_file', { path: 'x', patch: 'p' }),
          makeCall('c3', 'write_file', { path: 'x', content: 'v1' }),
        ])) as ExecResult[];

        // The edit changed state, so re-issuing the identical write is a
        // plausible restore — it must execute, not be swallowed as a glitch.
        assert.equal(
          countStarts(probe, 'write_file'),
          2,
          'post-mutation identical write must run',
        );
        assert.equal(results[2]?.result.status, 'executed');
      },
    );
  });

  it('shares the primary result for side-effect tool duplicates', async () => {
    const probe = newProbe();
    await withDispatchHarness(
      {
        tools: { write_file: probeTool(probe, 'write_file', 5) },
      },
      async ({ node }) => {
        const results = (await runDispatch(node, [
          makeCall('c1', 'write_file', { path: 'a', content: 'x' }),
          makeCall('c2', 'write_file', { path: 'a', content: 'x' }),
        ])) as ExecResult[];

        assert.equal(
          countStarts(probe),
          1,
          'the side effect must run exactly once',
        );
        assert.equal(results[0]?.result.status, 'executed');
        // Accidental GPT re-emissions get the primary's result, not an error.
        assertDuplicateInheritsOutput(results);
        assert.deepEqual(
          results[1]?.editedFiles,
          [],
          'duplicate must not re-track edits',
        );
      },
    );
  });
});
