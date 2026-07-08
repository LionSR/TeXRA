import { create, type Draft } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { sumUsageStats } from '@shared/schemas';

import {
  isToolUseState,
  isWorkflowState,
  type StreamState,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from '../store';
import { updateParentStreamId } from '../stateUtils';
import type { HandlerRegistry } from '../messageHandlerTypes';

const isRunUsageOwner = (
  state: StreamState,
): state is ToolUseStreamState | WorkflowStreamState =>
  isToolUseState(state) || isWorkflowState(state);

/**
 * Apply `mutate` to `draft` only when `prev` (the pre-mutation snapshot the
 * union was narrowed from) satisfies `guard`. Centralizes the single
 * necessarily-unsafe cast — `mutative`'s `Draft<T>` can't be narrowed from a
 * guard on the un-drafted `prev` — instead of repeating it at every call site.
 */
function withDraftKind<S extends StreamState>(
  draft: Draft<StreamState>,
  prev: StreamState,
  guard: (state: StreamState) => state is S,
  mutate: (typedDraft: Draft<S>) => void,
): void {
  if (guard(prev)) mutate(draft as Draft<S>);
}

// `HandlerRegistry` is now exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const syncHandlers = {
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data, ctx) => {
    if (!data.stream || data.action === 'clear') return;

    const hasWorkflowFiles =
      data.workflowFiles !== undefined ||
      data.workflowMissingOutputs !== undefined ||
      data.workflowCompileFailures !== undefined;
    const hasTaskData =
      data.todos !== undefined ||
      data.plan !== undefined ||
      data.queuedFollowUps !== undefined;
    const hasMeta =
      data.conversationProgress !== undefined ||
      'roundStage' in data ||
      data.badges !== undefined;
    const hasRunUsage = data.runUsage !== undefined;
    const hasContext = data.contextState !== undefined;

    if (
      hasWorkflowFiles ||
      hasTaskData ||
      hasMeta ||
      hasRunUsage ||
      hasContext
    ) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
          // contextState is a base field shared by workflow and tool-use.
          if (hasContext) {
            draft.contextState = data.contextState;
          }

          if (hasWorkflowFiles) {
            withDraftKind(draft, prev, isWorkflowState, (d) => {
              // Replace (not merge) so a clean operation that shrinks the
              // backend's set is reflected after a tab switch — Object.assign
              // would leak stale rounds.
              if (data.workflowFiles) d.files = { ...data.workflowFiles };
              if (data.workflowMissingOutputs) {
                d.missingOutputs = { ...data.workflowMissingOutputs };
              }
              if (data.workflowCompileFailures) {
                d.compileFailures = { ...data.workflowCompileFailures };
              }
            });
          }

          // runUsage is per-run for both workflow and tool-use; derive the
          // sum into sessionUsage so the UI always shows cumulative totals.
          // Replace (not merge) so a clean operation that shrinks the backend's
          // run set is reflected — Object.assign would leak stale entries and
          // over-count sessionUsage.
          if (hasRunUsage && data.runUsage) {
            withDraftKind(draft, prev, isRunUsageOwner, (d) => {
              d.runUsage = { ...data.runUsage };
              d.sessionUsage = sumUsageStats(Object.values(d.runUsage));
            });
          }

          if (hasTaskData) {
            withDraftKind(draft, prev, isToolUseState, (d) => {
              if (data.todos) d.todos = data.todos;
              if (data.plan !== undefined) d.plan = data.plan;
              if (data.queuedFollowUps)
                d.queuedFollowUps = data.queuedFollowUps;
            });
          }

          // Hydrate toggle bypass state on tab switch
          withDraftKind(draft, prev, isToolUseState, (d) => {
            if (data.toolEditBypass !== undefined)
              d.toolEditBypass = data.toolEditBypass;
            if (data.superYoloBypass !== undefined)
              d.superYoloBypass = data.superYoloBypass;
            // Treat goalActive as the source of truth: when it is
            // explicitly set, also overwrite status/objective. JSON drops
            // `undefined`, so the absence of these fields when active=false
            // is expected and means "clear them".
            if (data.goalActive !== undefined) {
              d.goalActive = data.goalActive;
              d.goalStatus = data.goalStatus;
              d.goalObjective = data.goalObjective;
            }
          });

          if (data.conversationProgress) {
            draft.conversationProgress = data.conversationProgress;
          }
          if ('roundStage' in data) {
            draft.roundStage = data.roundStage ?? undefined;
          }
          if (data.badges) {
            draft.activeSubagents = data.badges.activeSubagents;
            draft.finishedSubagentCount = data.badges.finishedSubagentCount;
            draft.activeProcesses = data.badges.activeProcesses;
            draft.finishedProcessCount = data.badges.finishedProcessCount;
          }
        }),
      );
    }

    if (data.parentStreamId !== undefined) {
      updateParentStreamId(ctx, data.stream as string, data.parentStreamId);
    }
  },
} satisfies Partial<HandlerRegistry>;
