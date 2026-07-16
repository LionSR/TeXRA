// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, beforeAll } from 'vitest';

// Local imports
import { createFakePlatform } from '@test/support/FakePlatform';
import { createRunTrace, StreamLogStore } from '@transcript';
import { ToolUseDispatchNode } from '@agent/core/flows/toolUseRound/ToolUseDispatchNode';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { delay } from '@utils/core';

import { withTestRunContext } from './progressTestUtils';

interface DispatchProbe {
  events: string[];
  inFlight: number;
  maxInFlight: number;
}

function probeTool(
  probe: DispatchProbe,
  name: string,
  delayMs: number,
  options: { parallelSafe?: boolean } = {},
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
      return { status: 'executed', output: `${tag} ok` };
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
  checkInterruption?: () => boolean;
  setAbortController?: (controller: AbortController | null) => void;
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
    checkInterruption: opts.checkInterruption ?? (() => false),
    setAbortController: opts.setAbortController ?? (() => {}),
    run: AgentRunStateSnapshotSchema.parse({}),
    workspace: AgentWorkspaceState.create(),
  } as unknown as ToolUseRoundServices<unknown>;
  const node = new ToolUseDispatchNode<unknown>();
  node.setServices(services);
  return { node, trace: runTrace.trace, dispose: () => runTrace.dispose() };
}

/** prep() then the batch executor, mirroring Node's _run sequence. */
async function runDispatch(
  node: ToolUseDispatchNode<unknown>,
  calls: SdkToolCall[],
  currentUserInstruction?: string,
): Promise<unknown[]> {
  const shared = {
    toolCalls: calls,
    shouldStop: false,
    messages: [],
    currentUserInstruction,
  };
  const prepped = await (
    node as unknown as { prep(s: unknown): Promise<SdkToolCall[]> }
  ).prep(shared);
  return await withTestRunContext(noopAgentRuntimeHost, 'dispatch-test', () =>
    (node as unknown as { _exec(items: unknown[]): Promise<unknown[]> })._exec(
      prepped,
    ),
  );
}

type ExecResult = {
  call: SdkToolCall;
  result: ToolResult;
  editedFiles: unknown[];
} | null;

describe('ToolUseDispatchNode parallel dispatch', () => {
  beforeAll(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({ workspacePath: '/workspace' }));
  });

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
    const { node, trace, dispose } = dispatchHarness({
      tools: { inspect_context: inspectContext },
      rootUserInstruction: 'Do not use files or external tools.',
    });

    try {
      await runDispatch(
        node,
        [makeCall('c1', 'inspect_context', {})],
        'Wrapped child instruction with prior handoff boilerplate.',
      );
      assert.equal(observedInstruction, 'Do not use files or external tools.');
      assert.equal(observedTrace, trace);
    } finally {
      dispose();
    }
  });

  it('executes contiguous parallel-safe calls concurrently, preserving order', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const { node, dispose } = dispatchHarness({
      tools: {
        grep: probeTool(probe, 'grep', 25, { parallelSafe: true }),
        read_file: probeTool(probe, 'read_file', 25, { parallelSafe: true }),
      },
    });
    try {
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
    } finally {
      dispose();
    }
  });

  it('treats non-safe tools as ordering barriers', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const { node, dispose } = dispatchHarness({
      tools: {
        read_file: probeTool(probe, 'read_file', 20, { parallelSafe: true }),
        write_file: probeTool(probe, 'write_file', 10),
      },
    });
    try {
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
    } finally {
      dispose();
    }
  });

  it('executes duplicate parallel calls once and fans the result out', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const { node, dispose } = dispatchHarness({
      tools: { grep: probeTool(probe, 'grep', 5, { parallelSafe: true }) },
    });
    try {
      const results = (await runDispatch(node, [
        makeCall('c1', 'grep', { pattern: 'same' }),
        makeCall('c2', 'grep', { pattern: 'same' }),
        makeCall('c3', 'grep', { pattern: 'other' }),
      ])) as ExecResult[];

      const startCount = probe.events.filter((e) =>
        e.startsWith('start '),
      ).length;
      assert.equal(startCount, 2, 'duplicate must not execute the tool again');

      assert.equal(results[1]?.call.callId, 'c2');
      assert.equal(results[1]?.result.status, 'executed');
      // The duplicate shares the primary's output, not an error.
      assert.equal(
        results[1]?.result.status === 'executed'
          ? results[1].result.output
          : undefined,
        results[0]?.result.status === 'executed'
          ? results[0].result.output
          : 'missing',
      );
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
    } finally {
      dispose();
    }
  });

  it('registers one batch abort controller that cancels concurrent calls', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const registered: (AbortController | null)[] = [];
    const { node, dispose } = dispatchHarness({
      tools: {
        grep: probeTool(probe, 'grep', 60, { parallelSafe: true }),
        read_file: probeTool(probe, 'read_file', 60, { parallelSafe: true }),
      },
      setAbortController: (controller) => registered.push(controller),
    });
    try {
      const pending = runDispatch(node, [
        makeCall('c1', 'grep', { pattern: 'a' }),
        makeCall('c2', 'read_file', { path: 'b' }),
      ]);
      await delay(15);
      const batchController = registered[0];
      assert.ok(batchController, 'batch controller should be registered');
      batchController.abort();

      const results = (await pending) as ExecResult[];
      assert.deepEqual(
        results,
        [null, null],
        'aborted concurrent calls should resolve to null',
      );
      // Exactly one controller for the whole batch, cleared afterwards.
      assert.deepEqual(registered, [batchController, null]);
    } finally {
      dispose();
    }
  });

  it('does not share read results across a mutating barrier', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const { node, dispose } = dispatchHarness({
      tools: {
        read_file: probeTool(probe, 'read_file', 5, { parallelSafe: true }),
        write_file: probeTool(probe, 'write_file', 5),
      },
    });
    try {
      const results = (await runDispatch(node, [
        makeCall('c1', 'read_file', { path: 'x' }),
        makeCall('c2', 'write_file', { path: 'x', content: 'new' }),
        makeCall('c3', 'read_file', { path: 'x' }),
      ])) as ExecResult[];

      const readStarts = probe.events.filter((e) =>
        e.startsWith('start read_file'),
      ).length;
      // The post-barrier read must execute again — the write may have
      // changed what it returns, so sharing the pre-barrier result would
      // feed the model stale contents.
      assert.equal(readStarts, 2, 'read after a barrier must re-execute');
      assert.equal(results[2]?.result.status, 'executed');
    } finally {
      dispose();
    }
  });

  it('leaves unsafe duplicates cancelled when their primary never ran', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    let interrupted = false;
    const { node, dispose } = dispatchHarness({
      tools: { write_file: probeTool(probe, 'write_file', 5) },
      checkInterruption: () => interrupted,
    });
    try {
      const calls = [
        makeCall('c1', 'write_file', { path: 'a', content: 'x' }),
        makeCall('c2', 'write_file', { path: 'a', content: 'x' }),
      ];
      const shared = { toolCalls: calls, shouldStop: false, messages: [] };
      const prepped = await (
        node as unknown as { prep(s: unknown): Promise<SdkToolCall[]> }
      ).prep(shared);
      // Interrupt lands after planning but before anything executes.
      interrupted = true;
      const results = (await withTestRunContext(
        noopAgentRuntimeHost,
        'dispatch-test',
        () =>
          (
            node as unknown as { _exec(items: unknown[]): Promise<unknown[]> }
          )._exec(prepped),
      )) as ExecResult[];

      assert.equal(probe.events.length, 0, 'nothing should execute');
      // The duplicate must not claim a "side effects" skip when no effect
      // happened at all — it is cancelled along with its primary.
      assert.deepEqual(results, [null, null]);
    } finally {
      dispose();
    }
  });

  it('allows an identical mutation again after a different mutation', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const { node, dispose } = dispatchHarness({
      tools: {
        write_file: probeTool(probe, 'write_file', 5),
        edit_file: probeTool(probe, 'edit_file', 5),
      },
    });
    try {
      const results = (await runDispatch(node, [
        makeCall('c1', 'write_file', { path: 'x', content: 'v1' }),
        makeCall('c2', 'edit_file', { path: 'x', patch: 'p' }),
        makeCall('c3', 'write_file', { path: 'x', content: 'v1' }),
      ])) as ExecResult[];

      // The edit changed state, so re-issuing the identical write is a
      // plausible restore — it must execute, not be rejected as a glitch.
      const writeStarts = probe.events.filter((e) =>
        e.startsWith('start write_file'),
      ).length;
      assert.equal(writeStarts, 2, 'post-mutation identical write must run');
      assert.equal(results[2]?.result.status, 'executed');
    } finally {
      dispose();
    }
  });

  it('rejects duplicates of side-effect tools instead of sharing the result', async () => {
    const probe: DispatchProbe = { events: [], inFlight: 0, maxInFlight: 0 };
    const { node, dispose } = dispatchHarness({
      tools: { write_file: probeTool(probe, 'write_file', 5) },
    });
    try {
      const results = (await runDispatch(node, [
        makeCall('c1', 'write_file', { path: 'a', content: 'x' }),
        makeCall('c2', 'write_file', { path: 'a', content: 'x' }),
      ])) as ExecResult[];

      const startCount = probe.events.filter((e) =>
        e.startsWith('start '),
      ).length;
      assert.equal(startCount, 1, 'the side effect must run exactly once');
      assert.equal(results[0]?.result.status, 'executed');
      // The duplicate must NOT claim the effect ran twice.
      assert.equal(results[1]?.result.status, 'error');
      assert.ok(
        results[1]?.result.status === 'error' &&
          results[1].result.error.includes('side effects'),
        'duplicate should explain why it was skipped',
      );
    } finally {
      dispose();
    }
  });
});
