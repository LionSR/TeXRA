/**
 * Workflow-script child-run strategy over the shared `childRunLoop`.
 *
 * Terminal-only: a workflow-script run executes once to completion inside
 * `launch` and delivers its result through the same follow-up-queue path every
 * detached child uses. No `runTurn` — the loop never calls it for a strategy
 * whose first (and only) turn is always terminal. This is the only strategy
 * that omits `runTurn`; `nativeSubagentStrategy.ts` declares one unconditionally
 * (it is merely unreachable for a workflow-category child).
 *
 * Host-agnostic, VS Code-free.
 */

// Local imports
import { readWorkflowScriptCheckpoint } from '@agent/workflowScript';
import type {
  WorkflowAgentInvocation,
  WorkflowAgentRunner,
  WorkflowScriptRunResult,
} from '@agent/workflowScript';
import type { AgentTrace } from '@agent/trace';
import type { ExecutionKVStore } from '@agent/storage';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type { WorkflowControlRegistry } from '@agent/runtime/workflowControlRegistry';
import type { ExecutionId, WorkflowExecutionSnapshot } from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import type { WorkflowScriptFiles } from '@shared/schemas/workflowScriptFiles';
import { truncateSummary } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';

// Local file imports
import {
  createWorkflowAttemptCostTracker,
  runPersistedWorkflowScriptWithProgress,
} from './workflowScriptRun';
import { fingerprintWorkflowAgentDependencies } from './workflowScriptAgentRunner';
import { createWorkflowDeliverySummaryCollector } from './workflowScriptDeliverySummary';

const RUN_LOG_MAX_LINES = 80;
const RUN_LOG_MAX_LINE_LENGTH = 500;

/** One model-facing reference for editing and rerunning a persisted script. */
export function formatWorkflowScriptReference(scriptPath: string): string {
  return [
    `Script file: ${scriptPath}`,
    `To revise and rerun it, edit that file and call ${DELEGATE_MULTI_AGENTS_TOOL_NAME} with scriptPath: '${scriptPath}'.`,
  ].join('\n');
}

interface RunLogCollector {
  readonly add: (line: string) => void;
  readonly format: () => string;
}

/** Retain a small, single-line tail for the invoking model. */
function createRunLogCollector(): RunLogCollector {
  const lines: string[] = [];
  let omitted = 0;
  return {
    add: (line) => {
      lines.push(truncateSummary(line, RUN_LOG_MAX_LINE_LENGTH));
      if (lines.length > RUN_LOG_MAX_LINES) {
        lines.shift();
        omitted += 1;
      }
    },
    format: () => {
      if (lines.length === 0) return '';
      const header =
        omitted > 0
          ? `=== Run log (last ${lines.length} lines; ${omitted} earlier ${omitted === 1 ? 'line' : 'lines'} omitted) ===`
          : '=== Run log ===';
      return `\n\n${header}\n${lines.join('\n')}`;
    },
  };
}

function formatWorkflowResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2) ?? 'undefined';
}

export interface WorkflowScriptStrategyParams {
  /** The detached run's execution id — echoed on the delivery envelope. */
  readonly executionId: ExecutionId;
  /** The run's child-stream trace — where phase/log progress projects. */
  readonly logger: AgentTrace;
  /** Orchestrator store that owns the durable journal (checkpoint anchor). */
  readonly store: ExecutionKVStore;
  readonly checkpointId: string;
  readonly script: string;
  /** Canonical editable path to this submitted script in the workspace. */
  readonly scriptPath: string;
  /** JSON arguments; `null`/`undefined` retains the checkpoint's arguments. */
  readonly args: unknown;
  /** Role-separated files exposed as immutable workflow launch context. */
  readonly files?: WorkflowScriptFiles;
  /** Durable identity (`meta.name`) — used in the resume hint on failure. */
  readonly name: string;
  /**
   * Session-owned registry the strategy registers this run's skip/retry bridge
   * on while the run is in flight, so a host can target a focused grandchild.
   */
  readonly workflowControls: WorkflowControlRegistry;
  /** Snapshot read from the detached run metadata that receives subsequent writes. */
  readonly initialSnapshot?: WorkflowExecutionSnapshot;
  /** Persist the canonical snapshot on the detached run metadata. */
  readonly onSnapshot?: (snapshot: WorkflowExecutionSnapshot) => Promise<void>;
  /** Persist-only when a headless caller awaits and returns the report itself. */
  readonly deliveryMode?: ChildRunStrategy<WorkflowScriptRunResult>['deliveryMode'];
  /**
   * Build the `agent()` adapter bound to the run's ancestry, wired to the
   * supplied per-live-child cost hook so delta accounting stays local to this
   * run.
   */
  readonly createRunAgent: (hooks: {
    readonly onCost: (
      invocation: WorkflowAgentInvocation,
      totalCostUsd: number | undefined,
    ) => void;
  }) => WorkflowAgentRunner;
}

/**
 * Create the terminal-only strategy that runs one durable workflow script as a
 * detached child. The run body — cost delta-accounting, run-log capture, and
 * progress projection onto the run's own stream — lives here; the tool only
 * launches it.
 */
export function createWorkflowScriptStrategy(
  params: WorkflowScriptStrategyParams,
): ChildRunStrategy<WorkflowScriptRunResult> {
  const runLog = createRunLogCollector();
  const summary = createWorkflowDeliverySummaryCollector(
    params.name,
    params.scriptPath,
  );

  return {
    stageLabel: `Workflow script '${params.name}'`,
    ...(params.deliveryMode && { deliveryMode: params.deliveryMode }),

    launch: async (ports, abortController) => {
      summary.start();
      // Physical-attempt callbacks are the current-invocation boundary: replay
      // and stable recovery emit none, while every model attempt emits one.
      const attemptCost = createWorkflowAttemptCostTracker();
      const runAgent = params.createRunAgent({
        onCost: (invocation, totalCostUsd) => {
          ports.recordCost(attemptCost.record(invocation, totalCostUsd ?? 0));
        },
      });

      let unregisterControls: (() => void) | undefined;
      // The engine flushes its terminal snapshot before it rethrows, so the
      // last one published is the run's own final account of what ran — the
      // only source the failure path has for phase and task tallies.
      let lastSnapshot: WorkflowExecutionSnapshot | undefined;
      let run: WorkflowScriptRunResult;
      try {
        run = await runPersistedWorkflowScriptWithProgress(params.logger, {
          store: params.store,
          checkpointId: params.checkpointId,
          ...(params.initialSnapshot !== undefined && {
            initialSnapshot: params.initialSnapshot,
          }),
          script: params.script,
          ...(params.args != null && { args: params.args }),
          ...(params.files !== undefined && {
            files: params.files,
          }),
          signal: abortController.signal,
          runAgent,
          fingerprintAgentDependencies: (options) =>
            fingerprintWorkflowAgentDependencies(params.executionId, options),
          getCallCostUsd: (index) => attemptCost.costForCall(index),
          onActivity: runLog.add,
          onSnapshot: async (snapshot) => {
            lastSnapshot = snapshot;
            await params.onSnapshot?.(snapshot);
          },
          // The engine's control is already keyed by the grandchild execution
          // id a host targets, so the run registers it as-is.
          onControl: (control) => {
            unregisterControls = params.workflowControls.register(
              params.executionId,
              control,
            );
          },
        });
      } catch (runError) {
        // Include newly journaled calls without re-billing the pre-run
        // baseline. A malformed checkpoint never masks the run error; live
        // candidates already recorded through the loop remain available.
        try {
          const checkpoint = await readWorkflowScriptCheckpoint(
            params.store,
            params.checkpointId,
          );
          const costUsd = attemptCost.total(checkpoint?.journal ?? []);
          ports.recordCost(costUsd);
          summary.settle(
            { journal: checkpoint?.journal ?? [], snapshot: lastSnapshot },
            costUsd,
          );
        } catch (settlementError) {
          // The run error is what the caller must see, so settlement cannot
          // rethrow — but dropping it silently loses this invocation's spend
          // from the parent's accounting. Say so.
          params.logger.warn(
            `Workflow script '${params.name}' failed and its cost could not be settled from the checkpoint; this run's spend is unbilled: ${toErrorMessage(settlementError)}`,
            { data: settlementError },
          );
        }
        throw runError;
      } finally {
        // The control handle outlives no in-flight call; drop the registration
        // the moment the run settles so a later host request cannot reach a
        // dead engine control.
        unregisterControls?.();
      }

      // The final journal supplies only this invocation's missing/lower
      // completed-call fallback; baseline history contributes zero.
      const costUsd = attemptCost.total(run.journal);
      ports.recordCost(costUsd);
      summary.settle(run, costUsd);
      return run;
    },

    isTerminal: () => true,

    // Wrap the free-form result in the shared child-run envelope so the async
    // follow-up carries the run's executionId, like every other detached
    // delivery — the invoking model correlates and can resume by that id.
    formatDelivery: (turn) =>
      formatChildRunDelivery(
        {
          tag: DELIVERY_TAG.workflowScriptResult,
          executionId: params.executionId,
        },
        {
          response: `${formatWorkflowResult(turn.result)}${runLog.format()}\n\n${formatWorkflowScriptReference(params.scriptPath)}`,
          lines: [summary.formatLine('completed')],
        },
      ),

    formatError: (_turn, err) => {
      const errorCause = toErrorMessage(err);
      return formatChildRunError(
        {
          tag: DELIVERY_TAG.workflowScriptError,
          executionId: params.executionId,
        },
        {
          message: `${errorCause}${runLog.format()}\n\n${formatWorkflowScriptReference(params.scriptPath)}\n\nCompleted agent() calls are journaled under meta.name '${params.name}'; rerunning that file resumes without repeating them.`,
          lines: [summary.formatLine('failed', errorCause)],
        },
      );
    },
  };
}
