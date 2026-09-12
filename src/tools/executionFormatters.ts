import { Effect } from 'effect';
import type { ChildRecord, RunListingEntry } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
/**
 * The one display model for the /executions surface: the listing lines, the
 * /executions/{id} summary line sets, and the predicates both answer their
 * questions with — what a run's display category is, whether it shows a model,
 * and which sub-paths it serves. Formatting only: the one exception is the
 * status reading, which asks `resolveRunLiveness` for the durable
 * ownership facts a missing in-process handle cannot supply.
 */

import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import {
  getRunContextRunId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import type { RunHandle, RunStatusInfo } from '@agent/runtime/RunHandle';
import type {
  AgentCategory,
  RunId,
  RunIdentity,
  TodoItem,
} from '@shared/schemas';
import {
  countByStatus,
  runIdentityName,
  RUN_OUTCOME,
  STATUS_DISPLAY,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';
import { formatTimestamp } from '@utils/text/stringUtils';

// Local imports - liveness
import {
  resolveRunLiveness,
  type RunLiveness,
  type KnownRunOutcome,
} from './executions/runLiveness';

/**
 * The display category of a run: an agent run shows its run mode
 * (`workflow` / `toolUse`), every other run shows what it IS
 * (`process` / `multiAgentWorkflow`). Identity-less legacy rows fall back to the
 * config's category.
 */
export type RunDisplayCategory =
  AgentCategory | Exclude<RunIdentity['kind'], 'agent'>;

export function runDisplayCategory(
  identity: RunIdentity | undefined,
  record: RunRecord | null | undefined,
): RunDisplayCategory | undefined {
  const agentCategory =
    record && isAgentRunRecord(record) ? record.agentCategory : undefined;
  if (!identity) return agentCategory;
  return identity.kind === 'agent' ? agentCategory : identity.kind;
}

/**
 * The model a run displays, or `null` when it displays none — one rule for the
 * listing and the summary, so the two cannot disagree about the same run.
 *
 * Honest non-agent records (a background process, a multi-agent workflow)
 * carry a model only when a real one backs the run, and then it is shown; a
 * legacy fabricated `AgentConfig` on a non-agent identity stays suppressed.
 */
function runDisplayModel(
  identity: RunIdentity | undefined,
  record: RunRecord | null | undefined,
): string | null {
  if (!record) return null;
  if (!isAgentRunRecord(record)) return record.model ?? null;
  return identity === undefined || identity.kind === 'agent'
    ? record.model
    : null;
}

function listingDisplay(entry: RunListingEntry): {
  agent: string;
  model: string | null;
  category: string | undefined;
} {
  switch (entry.kind) {
    case 'run':
      return {
        agent: runIdentityName(entry.identity),
        model: runDisplayModel(entry.identity, entry.record),
        category: runDisplayCategory(entry.identity, entry.record),
      };
    case 'incomplete':
      return { agent: 'unknown', model: 'unknown', category: undefined };
  }
}

/** Return paths available for a given agent category. */
function getAvailablePaths(
  category?: RunDisplayCategory,
  hasChildren?: boolean,
): string[] {
  const common = ['config', 'report', 'result'];
  if (hasChildren) common.push('children');
  switch (category) {
    case 'toolUse':
      return [...common, 'conversation', 'todos', 'workspace-files'];
    case 'workflow':
    case 'multiAgentWorkflow':
      return [...common, 'files'];
    case 'process':
      return [...common, 'output'];
    case undefined:
      // Unknown category (incomplete legacy row): offer every path.
      return [
        ...common,
        'conversation',
        'todos',
        'files',
        'workspace-files',
        'output',
      ];
    default:
      category satisfies never;
      return common;
  }
}

/** Format status info as a display string. */
export function formatStatusInfo(info: RunStatusInfo): string {
  const base = info.elapsed
    ? `${info.status} (${info.elapsed} elapsed)`
    : info.status;
  return info.detail ? `${base}: ${info.detail}` : base;
}

/**
 * The runtime status for a run ID, from `resolveRunLiveness`:
 * a live handle's phase, else the recorded outcome, else the fact that forbids
 * a terminal reading, else `cancelled` for an interrupted run.
 *
 * `knownOutcome` is the outcome the caller just read for this same request
 * (`null` when it read the run and found no terminal row), so a listing row
 * does not pay a second read of the facts it was built from. Omitting it
 * means "I have none", and the liveness resolver reads one. Never pass an
 * older reading: two surfaces reading the same run must not disagree about
 * how it ended.
 *
 * A run nothing alive owns and nothing terminalized reads `unknown`, never a
 * terminal outcome invented from the absence of a handle in this process.
 */
export const getRunStatusInfo = Effect.fn('getRunStatusInfo')(function* (
  runId: RunId,
  session: SessionHandle,
  knownOutcome?: KnownRunOutcome,
) {
  return statusInfoFromLiveness(
    yield* resolveRunLiveness(runId, session, knownOutcome),
  );
});

/**
 * The same reading for a caller that already resolved the liveness and needs
 * the arm itself (to word a footer, say) as well as the status line.
 */
export function statusInfoFromLiveness(liveness: RunLiveness): RunStatusInfo {
  switch (liveness.kind) {
    case 'live':
      return liveness.info;
    case 'unsettled':
      return { status: 'unknown', elapsed: null, detail: liveness.reason };
    case 'interrupted':
      return {
        status: RUN_OUTCOME.CANCELLED,
        elapsed: null,
        // The two facts this arm was decided from: nobody holds the run
        // claim and no outcome was ever recorded. Whether anything is left
        // to continue is the resume path's question, not this one.
        detail: 'interrupted; no owner and no recorded outcome',
      };
    case 'settled':
      return { status: liveness.outcome, elapsed: null };
  }
}

/** Format a listing entry as a single summary line. */
export const formatListingLine = Effect.fn('formatListingLine')(function* (
  entry: RunListingEntry,
  session: SessionHandle,
) {
  const ts = formatTimestamp(entry.timestamp);
  // The row was built from this run's metadata, outcome included, so the
  // status reading reuses it instead of reading the same file again.
  const info = yield* getRunStatusInfo(
    entry.id,
    session,
    entry.outcome ?? null,
  );
  const { agent, model, category } = listingDisplay(entry);
  const categoryTag = category ? `  ${category}` : '';
  const modelTag = model == null ? '' : `  ${model}`;
  const parentSuffix = entry.parentRunId ? `  parent=${entry.parentRunId}` : '';
  const descSuffix = entry.description ? `: ${entry.description}` : '';
  return `${entry.id}  ${ts}  ${agent}${categoryTag}${modelTag}  [${formatStatusInfo(info)}]${parentSuffix}${descSuffix}`;
});

/** Format todo items as a checklist. */
export function formatTodoSection(todos: readonly TodoItem[]): string[] {
  return todos.map((t) => `${STATUS_DISPLAY[t.status].icon} ${t.content}`);
}

/** Format a todo header with counts. */
export function formatTodoHeader(
  runId: RunId,
  todos: readonly TodoItem[],
): string {
  const { completed, inProgress, pending } = countByStatus(todos);
  return `Tasks for ${runId} (${completed} done, ${inProgress} active, ${pending} pending):`;
}

// ============================================================================
// /executions/{id} summary
// ============================================================================

/** Options controlling how showSummary renders a result report. */
export interface RunSummaryOptions {
  readonly suppressAutoDeliveredSubagentReport?: boolean;
}

/**
 * Whether a report already auto-delivered to the caller should be elided from
 * the summary: true when `handle` is a tool-use child whose parent run is
 * the calling run — i.e. the caller already receives this child's report
 * automatically as a follow-up, so /executions/{id} shouldn't duplicate it.
 * Deliberately identity-kind-agnostic: background bash processes
 * (`kind: 'process'`, category ToolUse) auto-deliver their reports exactly
 * like delegated agents do, and must stay suppressed too.
 */
export function shouldSuppressAutoDeliveredSubagentReport(
  options: RunSummaryOptions,
  handle: RunHandle,
): boolean {
  if (!options.suppressAutoDeliveredSubagentReport) return false;
  return (
    handle.category === 'toolUse' &&
    handle.isOwnedBy(getRunContextRunId(tryUseRunContext()))
  );
}

/** Format a single child run as a summary line. */
export const formatChildLine = Effect.fn('formatChildLine')(function* (
  child: ChildRecord,
  childRun: RunView | undefined,
  session: SessionHandle,
) {
  const info = yield* getRunStatusInfo(
    child.id,
    session,
    childRun && isTerminalOutcomePhase(childRun.status)
      ? childRun.status
      : null,
  );
  const ts = formatTimestamp(child.timestamp);
  const desc = childRun?.description ? `: ${childRun.description}` : '';
  return `${child.id}  ${ts}  ${child.agent}  [${formatStatusInfo(info)}]${desc}`;
});

/** Build the summary lines for a still-running run (in-memory handle). */
export function buildRunningSummaryLines(
  runId: RunId,
  handle: RunHandle,
  category: RunDisplayCategory | undefined,
  info: RunStatusInfo,
  run: RunView | undefined,
): string[] {
  const lines = [
    `Run: ${runId}`,
    `Agent: ${handle.agentName}`,
    ...(category ? [`Category: ${category}`] : []),
    `Started: ${new Date(handle.startedAt).toISOString()}`,
    `Status: ${formatStatusInfo(info)}`,
  ];

  if (run?.parentId) {
    lines.push(`Parent: ${run.parentId}`);
  }

  return lines;
}

/** Build the summary lines for a completed run (full KV fetch). */
export function buildCompletedSummaryLines(
  runId: RunId,
  record: RunRecord | null,
  identity: RunIdentity | undefined,
  category: RunDisplayCategory | undefined,
  info: RunStatusInfo,
  run: RunView | undefined,
): string[] {
  const name =
    record && (isAgentRunRecord(record) ? record.agent : record.name);
  const model = runDisplayModel(identity, record);
  const lines = [
    `Run: ${runId}`,
    `Agent: ${name ?? 'unknown'}`,
    ...(category ? [`Category: ${category}`] : []),
    ...(model === null ? [] : [`Model: ${model}`]),
    `Timestamp: ${run ? new Date(run.launchedAt).toISOString() : 'unknown'}`,
    `Status: ${formatStatusInfo(info)}`,
  ];

  if (run?.description) {
    lines.push(`Description: ${run.description}`);
  }

  if (run?.parentId) {
    lines.push(`Parent: ${run.parentId}`);
  }

  return lines;
}

/**
 * Build the todo/report/available-paths lines shared by both showSummary
 * branches. Appended after the (I/O-fetched) children lines, so this only
 * needs whether there were any children, not the records themselves.
 */
export function buildSummaryTailLines(
  runId: RunId,
  category: RunDisplayCategory | undefined,
  hasChildren: boolean,
  todos: readonly TodoItem[],
  report: string | null,
  options: { readonly suppressReport?: boolean } = {},
): string[] {
  const lines: string[] = [];

  if (todos.length > 0) {
    lines.push('', ...formatTodoSection(todos));
  }

  if (report && options.suppressReport) {
    lines.push(
      '',
      `Result: delivered automatically to this parent run as a follow-up message. Use /executions/${runId}/report to read the persisted report explicitly.`,
    );
  } else if (report) {
    lines.push('', 'Result:', report);
  }

  const paths = getAvailablePaths(category, hasChildren);
  lines.push(
    '',
    `Available paths: ${paths.map((p) => `/executions/${runId}/${p}`).join(', ')}`,
  );

  return lines;
}
