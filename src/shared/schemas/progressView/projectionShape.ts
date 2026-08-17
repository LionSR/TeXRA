/**
 * Canonical browser-safe projection shape for the webview content path.
 *
 * The full SYNC_STREAM_CONTENT render snapshot (the clear arm excluded) and
 * every targeted single-field outbound arm read the same value schemas from
 * here. Nothing in this module imports Node built-ins: the trace-viewer and
 * the extension both load it from a browser-safe bundle, so a runtime Node
 * import in this graph would break `file://` replay.
 */
import { z } from 'zod';

import { GoalStateSchema } from '../goal';
import { StreamTabIdSchema } from '../identifiers';
import { CompileFailureSchema, OutputFileInfoSchema } from '../output';
import { PlanSchema } from '../plan';
import { roundIndexedRecord } from '../roundIndexed';
import {
  ActiveChildInfoSchema,
  ConversationProgressSchema,
  StreamStageSchema,
} from '../streamState';
import { TodoItemSchema } from '../todo';
import { RunUsageMapSchema } from '../usage';

/** Leaf value schemas: declared once, referenced by every envelope below. */
const StreamContentProjectionLeaves = {
  stream: StreamTabIdSchema,
  runUsage: RunUsageMapSchema,
  conversationProgress: ConversationProgressSchema,
  stage: StreamStageSchema,
  subagents: z.array(ActiveChildInfoSchema),
  files: roundIndexedRecord(OutputFileInfoSchema),
  missing: roundIndexedRecord(z.string()),
  compileFailures: roundIndexedRecord(CompileFailureSchema),
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  queuedFollowUps: z.array(z.string()),
  bashBypass: z.boolean(),
  toolEditBypass: z.boolean(),
  superYoloBypass: z.boolean(),
  goal: GoalStateSchema,
};

const ActiveStateSectionSchema = z.strictObject({
  conversationProgress: StreamContentProjectionLeaves.conversationProgress,
  stage: StreamContentProjectionLeaves.stage.nullable(),
  badges: z.strictObject({
    subagents: StreamContentProjectionLeaves.subagents,
  }),
});

const OutputsSectionSchema = z.strictObject({
  files: StreamContentProjectionLeaves.files,
  missing: StreamContentProjectionLeaves.missing,
  compileFailures: StreamContentProjectionLeaves.compileFailures,
});

const WorkPlanSectionSchema = z.strictObject({
  todos: StreamContentProjectionLeaves.todos,
  plan: StreamContentProjectionLeaves.plan,
  queuedFollowUps: StreamContentProjectionLeaves.queuedFollowUps,
});

const ControlsSectionSchema = z.strictObject({
  bashBypass: StreamContentProjectionLeaves.bashBypass,
  toolEditBypass: StreamContentProjectionLeaves.toolEditBypass,
  superYoloBypass: StreamContentProjectionLeaves.superYoloBypass,
  goal: StreamContentProjectionLeaves.goal,
});

/**
 * The one place the projection field schemas are declared. Envelopes (SYNC
 * render and targeted arms) apply their own optionality/nullability at the
 * field boundary; this registry never restates a leaf or section type.
 */
const StreamContentProjectionValues = {
  ...StreamContentProjectionLeaves,
  activeState: ActiveStateSectionSchema,
  outputs: OutputsSectionSchema,
  workPlan: WorkPlanSectionSchema,
  controls: ControlsSectionSchema,
};

/**
 * Pick one projection value schema by its field name. Targeted outbound arms
 * derive their value schema here instead of re-declaring it, so a field added
 * to (or renamed in) the projection shape reaches every targeted arm at
 * compile time — the same factory idiom `RoundUpdateMessageSchema` proves for
 * the round-keyed arms.
 */
export function pickProjection<
  K extends keyof typeof StreamContentProjectionValues,
>(key: K): (typeof StreamContentProjectionValues)[K] {
  return StreamContentProjectionValues[key];
}
