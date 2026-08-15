/**
 * Tool-use round flow: Prep → Call → Process → Dispatch, looping until end-of-turn.
 *
 * A "round" is one LLM invocation plus the dispatch of any tool calls it returns.
 * The loop repeats until the model stops requesting tools (end-of-turn).
 *
 * This is the inner primitive invoked by ToolUseCycleNode (the outer session step).
 * The distinction:
 *   - ToolUseRoundFlow  (this file) = one LLM invocation + tool dispatch loop
 *   - ToolUseCycleNode  (implementations/flows/tooluse) = one session turn,
 *     which may invoke many rounds via createToolUseRoundFlow()
 *
 * This file owns the flow factory only. The node implementations and the
 * shared schema/state types live in ./toolUseRound/ and are imported from the
 * file that defines them — this module re-exports nothing.
 */

// Local imports - core flow primitives
import { Flow } from '@agent/node';
import { defaultPostCompactionContext } from '@agent/core/flows/CommonCycleTypes';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import { ModelInvocationNode } from './ModelInvocationNode';
import { ToolUseRoundPrepNode } from './toolUseRound/ToolUseRoundPrepNode';
import { ToolUseProcessNode } from './toolUseRound/ToolUseProcessNode';
import { ToolUseDispatchNode } from './toolUseRound/ToolUseDispatchNode';
import type { ToolUseRoundServices } from './CycleServices';
import type { ToolUseRoundShared } from './toolUseRound/roundShared';

/**
 * Creates a tool-use round flow with services injected via params.
 *
 * Flow structure:
 *   Prep → Call → Process → Dispatch
 *     ↑           |            |
 *     └───────────┴ CONTINUE ──┘
 *
 * Queued user messages (typed during tool execution) are injected in PrepNode
 * BEFORE calling the model, so the model's thinking/response considers the
 * user's feedback.
 */
export function createToolUseRoundFlow<C>(): Flow<
  ToolUseRoundShared,
  ToolUseRoundServices<C>
> {
  const prepNode = new ToolUseRoundPrepNode<C>();
  const callNode = new ModelInvocationNode<
    ToolUseRoundShared,
    ToolUseRoundServices<C>
  >({
    operationName: 'Model request',
    streaming: true,
    // Only resupply for providers that need it per-call (Anthropic, Google).
    // Providers that embed the system prompt into `messages` at session init
    // (OpenAI, OpenRouter) already have it in history — resupplying it here
    // too would duplicate it alongside the persisted message.
    getSystemPrompt: (shared, services) =>
      services.modelCell.handler.requiresPerCallSystemPrompt
        ? shared.systemPrompt
        : undefined,
    getFinalTool: (shared) => shared.finalTool,
    storeResponse: (shared, response) => {
      shared.response = response;
    },
    getPostCompactionContext: defaultPostCompactionContext,
    getDebugFileOptions: (shared) => ({
      continuationCount: shared.roundIndex,
      baseName: 'tooluse_response',
    }),
  });
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);
  processNode.on(FlowTransition.CONTINUE, prepNode);
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseRoundShared, ToolUseRoundServices<C>>(prepNode);
}
