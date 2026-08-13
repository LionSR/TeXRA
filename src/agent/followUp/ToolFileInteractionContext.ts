// Third-party imports
import { AsyncLocalStorage } from 'node:async_hooks';

// Type imports
import type { AgentTrace } from '@agent/trace';
import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import {
  createRunContext,
  tryUseRunContext,
  withRunContext,
  type CreateRunContextOptions,
  type RunContext,
} from '@agent/runtime/RunContext';

/** Optional lifecycle callbacks a tool call may be given, grouped since they
 *  vary together by call site rather than independently. */
interface ToolCallHooks {
  /** Called by tools with approval flows to trigger in-progress log after approval. */
  onExecutionReady?: () => void;
  /** Called by tools to push partial output for live streaming to the UI. */
  onToolOutput?: (chunk: string) => void;
  /**
   * Roll a completed subagent's model cost (USD) into the parent run's usage
   * totals. Delegation tools call this when a child run finishes so parent
   * usage displays cover the whole subtree.
   * Safe to call after the originating tool call returned (async subagents
   * complete later); it mutates the live run accumulator directly.
   */
  recordSubagentCost?: (costUsd: number) => void;
}

/** Fields that belong to one concrete tool call or tool-cycle state snapshot. */
export interface ToolCallContext {
  toolCallId?: string;
  tracker: FileInteractionState;
  /** Parent trace used to project nested tool activity onto the same stream tree. */
  trace?: AgentTrace;
  /** User instruction that led to this tool call, when available. */
  userInstruction?: string;
  /** Plan and todo progress state. Absent in contexts without work-plan support. */
  workPlanState?: WorkPlanState;
  /** Aborts when the current tool call is cancelled by the owning agent run. */
  signal?: AbortSignal;
  hooks?: ToolCallHooks;
}

export interface CurrentToolContexts {
  runContext: RunContext | undefined;
  callContext: ToolCallContext;
}

const contextStackScope = new AsyncLocalStorage<readonly ToolCallContext[]>();

export async function withToolFileInteractionContext<T>(
  context: ToolCallContext,
  run: () => Promise<T> | T,
): Promise<T> {
  const parentStack = contextStackScope.getStore() ?? [];
  return contextStackScope.run([...parentStack, context], async () => run());
}

export function getCurrentToolCallContext(): ToolCallContext | undefined {
  return contextStackScope.getStore()?.at(-1);
}

export function getCurrentToolContexts(): CurrentToolContexts | undefined {
  const callContext = getCurrentToolCallContext();
  if (!callContext) {
    return undefined;
  }
  return {
    runContext: tryUseRunContext(),
    callContext,
  };
}

/**
 * Test helper: install a RunContext and a tool-call frame in one call.
 *
 * Tests that exercise tools-side code typically need both an active run
 * (for `tryUseRunContext()` consumers) and a tool-call frame (for tracker
 * and callbacks). This wraps the two stack pushes in one composer.
 */
export function withToolEnvironment<T>(
  env: { run: CreateRunContextOptions; call: ToolCallContext },
  fn: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve(
    withRunContext(createRunContext(env.run), () =>
      withToolFileInteractionContext(env.call, fn),
    ),
  );
}
