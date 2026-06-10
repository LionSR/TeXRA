/**
 * Tool-use cycle flow: Prep → Call → Process → Dispatch, looping until end-of-turn.
 *
 * This file is the public entry point. The node implementations and shared
 * types live in ./toolUseCycle/; external consumers import the flow factory
 * and shared schema/state types from here.
 */

// Local imports - core flow primitives
import { Flow } from '@agent/node';
import { defaultPostCompactionContext } from '@agent/core/flows/CommonCycleTypes';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import { ModelInvocationNode } from './ModelInvocationNode';
import { ToolUsePrepNode } from './toolUseCycle/ToolUsePrepNode';
import { ToolUseProcessNode } from './toolUseCycle/ToolUseProcessNode';
import { ToolUseDispatchNode } from './toolUseCycle/ToolUseDispatchNode';
import type { CycleParams, ToolUseCycleServices } from './CycleServices';
import type { ToolUseCycleShared } from './toolUseCycle/cycleShared';

export {
  ToolUseCycleFieldsSchema,
  type ToolUseCycleFields,
  type ToolUseCycleShared,
} from './toolUseCycle/cycleShared';

/**
 * Creates a tool-use cycle flow with services injected via params.
 *
 * Flow structure:
 *   Prep → Call → Process → Dispatch
 *     ↑                        |
 *     └────── CONTINUE ────────┘
 *
 * Queued user messages (typed during tool execution) are injected in PrepNode
 * BEFORE calling the model, so the model's thinking/response considers the
 * user's feedback.
 */
export function createToolUseCycleFlow<C>(): Flow<
  ToolUseCycleShared,
  CycleParams
> {
  const prepNode = new ToolUsePrepNode<C>();
  const callNode = new ModelInvocationNode<
    ToolUseCycleShared,
    CycleParams,
    ToolUseCycleServices<C>
  >({
    operationName: 'Tool-use call',
    streaming: true,
    storeResponse: (shared, response) => {
      shared.response = response;
    },
    getPostCompactionContext: defaultPostCompactionContext,
    getDebugFileOptions: (shared) => ({
      continuationCount: shared.cycleIndex,
      baseName: 'tooluse_response',
    }),
  });
  const processNode = new ToolUseProcessNode<C>();
  const dispatchNode = new ToolUseDispatchNode<C>();

  prepNode.next(callNode);
  callNode.next(processNode);
  processNode.next(dispatchNode);
  dispatchNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ToolUseCycleShared, CycleParams>(prepNode);
}
