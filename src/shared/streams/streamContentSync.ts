import {
  AgentCategory,
  type StreamContentRenderPayload,
  type StreamTabId,
} from '@shared/schemas';

type WorkflowRender = Extract<
  StreamContentRenderPayload,
  { category: typeof AgentCategory.Workflow }
>;
type ToolUseRender = Extract<
  StreamContentRenderPayload,
  { category: typeof AgentCategory.ToolUse }
>;

/**
 * Browser-safe per-stream source the SYNC_STREAM_CONTENT render snapshot is
 * assembled from. The live backend materializes it from `SessionState` reads;
 * trace replay materializes it from the archived `StreamSnapshot` — neither
 * side re-states the payload shape. Category-specific sections may be lazy
 * (object-literal getters) so a workflow render never touches tool-use
 * sources and vice versa.
 */
export interface StreamContentSource {
  readonly runUsage: StreamContentRenderPayload['runUsage'];
  readonly activeState?: StreamContentRenderPayload['activeState'];
  readonly outputs: WorkflowRender['outputs'];
  readonly workPlan: ToolUseRender['workPlan'];
  readonly controls: ToolUseRender['controls'];
}

/**
 * The one assembly of the SYNC_STREAM_CONTENT render payload: the shared
 * block (`action`/`stream`/`runUsage`/optional `activeState`) plus the
 * category-discriminated section. Nothing in this module's import graph may
 * reach a Node built-in: the trace-viewer calls it from a browser-only
 * `file://` bundle (see `projectionShape.ts` for the same constraint on the
 * schema side).
 */
export function buildStreamContentRender(
  stream: StreamTabId,
  category: AgentCategory,
  source: StreamContentSource,
): StreamContentRenderPayload {
  const shared = {
    action: 'render' as const,
    stream,
    runUsage: source.runUsage,
    ...(source.activeState ? { activeState: source.activeState } : {}),
  };
  return category === AgentCategory.Workflow
    ? { ...shared, category, outputs: source.outputs }
    : {
        ...shared,
        category,
        workPlan: source.workPlan,
        controls: source.controls,
      };
}
