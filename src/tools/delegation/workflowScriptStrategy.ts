/**
 * Workflow-script child-run strategy over the shared `childRunLoop`.
 *
 * Terminal-only: a workflow-script run executes once to completion inside
 * `launch` and delivers its result through the same follow-up-queue path every
 * detached child uses. No `runTurn` — the loop never calls it for a strategy
 * whose first (and only) turn is always terminal (the same shape
 * `createNativeWorkflowStrategy` uses).
 *
 * Host-agnostic, VS Code-free.
 */

// Local imports - agent runtime
import { readWorkflowScriptCheckpoint } from '@agent/workflowScript';
import type {
  WorkflowAgentInvocation,
  WorkflowAgentRunner,
  WorkflowScriptRunResult,
} from '@agent/workflowScript';
import type { AgentTrace } from '@agent/trace';
import type { ExecutionKVStore } from '@agent/storage';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type {
  WorkflowControlRegistry,
  WorkflowRunControl,
} from '@agent/runtime/workflowControlRegistry';
import type { ExecutionId } from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';

// Local imports - shared

// Local imports - tools
import {
  formatChildRunDelivery,
  formatChildRunError,
} from '@tools/deliveryEnvelope';
import { truncateSummary } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - utilities

// Local imports - delegation
import {
  runPersistedWorkflowScriptWithProgress,
  sumCurrentWorkflowRunCost,
  workflowJournalEntryCostIdentity,
} from './workflowScriptRun';

const RUN_LOG_MAX_LINES = 80;
const RUN_LOG_MAX_LINE_LENGTH = 500;

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
  /** JSON arguments; `null`/`undefined` retains the checkpoint's arguments. */
  readonly args: unknown;
  /** Durable identity (`meta.name`) — used in the resume hint on failure. */
  readonly name: string;
  /**
   * Session-owned registry the strategy registers this run's skip/retry bridge
   * on while the run is in flight, so a host can target a focused grandchild.
   */
  readonly workflowControls: WorkflowControlRegistry;
  /**
   * Build the `agent()` adapter bound to the run's ancestry, wired to the
   * supplied per-live-child cost hook so delta accounting stays local to this
   * run, plus the child-active hook that maps a live grandchild's execution id
   * to its engine call index.
   */
  readonly createRunAgent: (hooks: {
    readonly onCost: (
      invocation: WorkflowAgentInvocation,
      totalCostUsd: number | undefined,
    ) => void;
    readonly onChildActive: (
      grandchildExecutionId: ExecutionId,
      invocation: WorkflowAgentInvocation,
      active: boolean,
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

  return {
    stageLabel: `Workflow script '${params.name}'`,

    launch: async (ports, abortController) => {
      // The stable child runner's native cost callback fires only for work
      // that executes in this attempt; exact journal replays and stable-child
      // recoveries do not fire it. Keep every observed attempt by stable call
      // identity so discarded retry/skip/failure work is still billed while a
      // pure journal replay settles zero.
      const observedCosts = new Map<string, number>();
      let liveCostUsd = 0;
      // Live grandchild execution id → engine call index, maintained by the
      // runner's child-active hook. The identity bridge that lets an
      // execution-id-keyed host action reach the engine's index-keyed control.
      const liveCallIndexByChild = new Map<ExecutionId, number>();
      const runAgent = params.createRunAgent({
        onCost: (invocation, totalCostUsd) => {
          const cost = totalCostUsd ?? 0;
          const identity = workflowJournalEntryCostIdentity(invocation);
          observedCosts.set(
            identity,
            (observedCosts.get(identity) ?? 0) + cost,
          );
          liveCostUsd += cost;
        },
        onChildActive: (grandchildExecutionId, invocation, active) => {
          if (active) {
            liveCallIndexByChild.set(grandchildExecutionId, invocation.index);
          } else {
            liveCallIndexByChild.delete(grandchildExecutionId);
          }
        },
      });

      let unregisterControls: (() => void) | undefined;
      let run: WorkflowScriptRunResult;
      try {
        run = await runPersistedWorkflowScriptWithProgress(params.logger, {
          store: params.store,
          checkpointId: params.checkpointId,
          script: params.script,
          ...(params.args != null && { args: params.args }),
          signal: abortController.signal,
          runAgent,
          getLiveCostUsd: () => liveCostUsd,
          onActivity: runLog.add,
          onControl: (control) => {
            // Translate an execution-id-keyed host request into an
            // index-keyed engine action; unknown/settled children no-op,
            // matching the engine's own not-in-flight semantics.
            const runControl: WorkflowRunControl = {
              skip: (grandchildId) => {
                const index = liveCallIndexByChild.get(grandchildId);
                if (index !== undefined) control.skip(index);
              },
              retry: (grandchildId) => {
                const index = liveCallIndexByChild.get(grandchildId);
                if (index !== undefined) control.retry(index);
              },
            };
            unregisterControls = params.workflowControls.register(
              params.executionId,
              runControl,
            );
          },
        });
      } catch (runError) {
        // Settle whatever the journal recorded before the failure so a resumed
        // run still rolls up already-spent cost. Settlement failure never
        // masks the run error — the run log and resume hint are the model's
        // only view into what executed.
        try {
          const checkpoint = await readWorkflowScriptCheckpoint(
            params.store,
            params.checkpointId,
          );
          ports.recordCost(
            sumCurrentWorkflowRunCost(checkpoint?.journal ?? [], observedCosts),
          );
        } catch {
          // Cost settlement is best-effort on the failure path.
        }
        throw runError;
      } finally {
        // The control handle outlives no in-flight call; drop the registration
        // the moment the run settles so a later host request cannot reach a
        // dead engine control.
        unregisterControls?.();
      }

      // Combine observed attempts with journal-authoritative completed costs;
      // a malformed journal fails closed before any scalar is recorded.
      ports.recordCost(sumCurrentWorkflowRunCost(run.journal, observedCosts));
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
        { response: `${formatWorkflowResult(turn.result)}${runLog.format()}` },
      ),

    formatError: (_turn, err) =>
      formatChildRunError(
        {
          tag: DELIVERY_TAG.workflowScriptError,
          executionId: params.executionId,
        },
        {
          message: `${toErrorMessage(err)}${runLog.format()}\n\nCompleted agent() calls are journaled under meta.name '${params.name}': call ${DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME} again with the same meta.name to resume without repeating them.`,
        },
      ),
  };
}
