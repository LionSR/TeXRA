// Third-party imports
import { AsyncLocalStorage } from 'async_hooks';

// Type imports
import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/AgentWorkspaceState';
import {
  tryUseRunContext,
  type ToolRunContext,
} from '@agent/runtime/RunContext';

export type { ToolRunContext } from '@agent/runtime/RunContext';

/** Fields that belong to one concrete tool call or tool-cycle state snapshot. */
export interface ToolCallContext {
  toolCallId?: string;
  tracker: FileInteractionState;
  /** Plan and todo progress state. Absent in contexts without work-plan support. */
  workPlanState?: WorkPlanState;
  /** Called by tools with approval flows to trigger in-progress log after approval. */
  onExecutionReady?: () => void;
  /** Called by tools to push partial output for live streaming to the UI. */
  onToolOutput?: (chunk: string) => void;
}

export interface ToolFileInteractionContext
  extends ToolRunContext, ToolCallContext {}

interface ToolContextFrame {
  full: ToolFileInteractionContext;
  run: ToolRunContext;
  call: ToolCallContext;
}

export interface CurrentToolContexts {
  runContext: ToolRunContext;
  callContext: ToolCallContext;
}

const contextStackScope = new AsyncLocalStorage<readonly ToolContextFrame[]>();

type ContextKeyMap<T> = { [K in keyof T]-?: true };

const TOOL_RUN_CONTEXT_KEYS = {
  streamId: true,
  executionId: true,
  model: true,
  agentName: true,
  workingDirectory: true,
  runtimeHost: true,
  delegationDepth: true,
  delegationConfig: true,
} satisfies ContextKeyMap<ToolRunContext>;

const TOOL_CALL_CONTEXT_KEYS = {
  toolCallId: true,
  tracker: true,
  workPlanState: true,
  onExecutionReady: true,
  onToolOutput: true,
} satisfies ContextKeyMap<ToolCallContext>;

function pickContextFields<T extends object>(
  context: T,
  keyMap: ContextKeyMap<T>,
): T {
  const fields = {} as T;
  for (const key of Object.keys(keyMap) as (keyof T)[]) {
    fields[key] = context[key];
  }
  return fields;
}

function buildContextFrame(
  context: ToolFileInteractionContext,
): ToolContextFrame {
  const fullContext = {
    ...tryUseRunContext()?.toolRunContext,
    ...context,
  };
  return {
    full: fullContext,
    run: pickContextFields<ToolRunContext>(fullContext, TOOL_RUN_CONTEXT_KEYS),
    call: pickContextFields<ToolCallContext>(
      fullContext,
      TOOL_CALL_CONTEXT_KEYS,
    ),
  };
}

export function withToolFileInteractionContext<T>(
  context: ToolFileInteractionContext,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    const parentStack = contextStackScope.getStore() ?? [];
    return contextStackScope.run(
      [...parentStack, buildContextFrame(context)],
      async () => run(),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

export function getCurrentToolFileInteractionContext():
  | ToolFileInteractionContext
  | undefined {
  return contextStackScope.getStore()?.at(-1)?.full;
}

export function getCurrentToolRunContext(): ToolRunContext | undefined {
  return contextStackScope.getStore()?.at(-1)?.run;
}

export function getCurrentToolCallContext(): ToolCallContext | undefined {
  return contextStackScope.getStore()?.at(-1)?.call;
}

export function getCurrentToolContexts(): CurrentToolContexts | undefined {
  const frame = contextStackScope.getStore()?.at(-1);
  if (!frame) {
    return undefined;
  }

  return {
    runContext: frame.run,
    callContext: frame.call,
  };
}
