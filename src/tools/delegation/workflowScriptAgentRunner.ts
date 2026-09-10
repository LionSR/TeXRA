// Third-party imports
import { Cause, Effect } from 'effect';

// Local imports
import {
  WorkflowRunAbortError,
  type WorkflowAgentInvocation,
} from '@agent/workflowScript';
import type { AgentEntry } from '@agent/index/agentEntry';
import { runInSession, type LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { formatError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { AgentCategory } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { ensureError } from '@utils/errors/errorMessage';
import { deriveExecutionId } from '@utils/core/idHash';

// Local file imports
import { executeStableSubagentInBand } from './inBandSubagentExecution';
import { SubagentDurabilityError } from './stableSubagentAttempt';
import {
  resolveInvocationFileList,
  rejectOversizedBibAttachments,
} from './inputFields';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { requireVisibleAgent } from './proposalFlow';

const log = createLog('workflowScriptAgentRunner');

function workflowScriptModelSelection(
  invocation: Pick<WorkflowAgentInvocation, 'options'>,
  parent: LaunchRunContext,
): Effect.Effect<string, Error> {
  const requestedModel = invocation.options.model;
  return selectAvailableDelegationModel({
    ...(requestedModel !== undefined && { requestedModel }),
    parentModel: parent.model,
    withScope: <T>(read: () => T) =>
      runInSession(parent.runScope.session, read),
  }).pipe(
    Effect.mapError((error) => {
      // A declared model is workflow configuration, so its rejection must not
      // disappear as a nullable call inside parallel(). When the
      // script omits the field, preserve the established delegation failure
      // semantics; per-call model routing must not broaden that behavior.
      if (requestedModel === undefined) return ensureError(error);
      return new WorkflowRunAbortError(
        formatError('Workflow model could not be selected', error),
        { cause: error },
      );
    }),
  );
}

/**
 * Identity of the detached workflow-run that owns this script's `agent()`
 * grandchildren. Re-rooting them here (instead of the orchestrator) gives a
 * clean 3-level tree; orchestrator → run → agent; so killing the run
 * cascades to its in-flight child. Both fields are stable across relaunch:
 * `executionId` is derived deterministically from the checkpoint identity, so
 * the grandchild execution ids and run-storage lineage stay consistent when a
 * timed-out run is resumed under the same `meta.name`.
 */
interface WorkflowRunIdentity {
  readonly executionId: RunId;
}

/**
 * Resolve what one issued `agent()` call actually runs; agent, model, result
 * contract, and files; from the options the script declared.
 */
const resolveWorkflowCallConfig = Effect.fn('resolveWorkflowCallConfig')(
  function* (
    call: Pick<WorkflowAgentInvocation, 'prompt' | 'options'>,
    parent: LaunchRunContext,
    defaultAgent: AgentEntry,
    runExecutionId: RunId,
  ): Effect.fn.Return<
    { configPayload: AgentConfigPayload; agentName: string },
    Error
  > {
    const { runScope } = parent;
    const sharedConfigFields = {
      instruction: call.prompt,
      ...(runScope.workingDirectory !== undefined && {
        workingDirectory: runScope.workingDirectory,
      }),
      ...(runScope.delegationAgentScope && {
        delegationAgentScope: runScope.delegationAgentScope,
      }),
    };
    let configPayload: AgentConfigPayload;
    let agentName: string;

    if (call.options.schema !== undefined) {
      const agent = requireVisibleAgent(
        AgentCategory.ToolUse,
        call.options.agentName,
        runScope.delegationAgentScope ?? undefined,
      );
      const model = yield* workflowScriptModelSelection(call, parent);
      agentName = agent.name;
      configPayload = {
        ...sharedConfigFields,
        agent: agent.name,
        agentSource: agent.source,
        model,
        agentCategory: AgentCategory.ToolUse,
        outputSchema: call.options.schema,
      };
    } else {
      const agent =
        call.options.agentName === undefined
          ? defaultAgent
          : requireVisibleAgent(
              AgentCategory.Workflow,
              call.options.agentName,
              runScope.delegationAgentScope ?? undefined,
            );
      if (agent.category !== AgentCategory.Workflow) {
        throw new WorkflowRunAbortError(
          `Agent '${agent.name}' is a ${agent.category} agent but was ` +
            `launched as workflow. Use delegate_agent instead.`,
        );
      }
      // Model resolves before any file I/O so an unavailable/invalid
      // declared model fails the call without touching the filesystem.
      const model = yield* workflowScriptModelSelection(call, parent);
      const [inputs, context, media] = yield* Effect.all([
        resolveInvocationFileList(
          runScope.session,
          runExecutionId,
          'Input file',
          call.options.inputFiles ?? [],
        ),
        resolveInvocationFileList(
          runScope.session,
          runExecutionId,
          'Context file',
          call.options.contextFiles ?? [],
        ),
        resolveInvocationFileList(
          runScope.session,
          runExecutionId,
          'Media file',
          call.options.mediaFiles ?? [],
        ),
      ]);
      const inputFiles = inputs.map(({ file }) => file);
      const contextFiles = context.map(({ file }) => file);
      const mediaFiles = media.map(({ file }) => file);
      const oversizedBibRejection = yield* Effect.tryPromise({
        try: () =>
          runInSession(runScope.session, () =>
            rejectOversizedBibAttachments(contextFiles),
          ),
        catch: ensureError,
      });
      if (oversizedBibRejection) {
        throw new WorkflowRunAbortError(oversizedBibRejection.error);
      }
      agentName = agent.name;
      configPayload = {
        ...sharedConfigFields,
        agent: agent.name,
        agentSource: agent.source,
        model,
        inputFiles,
        contextFiles,
        mediaFiles,
        agentCategory: AgentCategory.Workflow,
      };
    }
    return { configPayload, agentName };
  },
);

/** Build the production `agent()` adapter for one workflow-script run. */
export function createWorkflowScriptAgentRunner(
  parent: LaunchRunContext,
  defaultAgent: AgentEntry,
  checkpointId: string,
  run: WorkflowRunIdentity,
  hooks?: {
    /** Fires per live child on success and failure with its total cost. */
    readonly onCost?: (
      invocation: WorkflowAgentInvocation,
      totalCostUsd: number | undefined,
    ) => void;
  },
): (
  invocation: WorkflowAgentInvocation,
) => Effect.Effect<AgentFinalResult, Error> {
  const { runScope } = parent;

  return Effect.fn('workflowScriptAgent')(
    function* (
      invocation: WorkflowAgentInvocation,
    ): Effect.fn.Return<AgentFinalResult, Error> {
      const logicalExecutionId = deriveExecutionId({
        checkpointId,
        key: invocation.key,
        parentExecutionId: run.executionId,
      });
      // The id this attempt actually runs (and registers its child stream)
      // under: the logical id on attempt 0, an attempt-specific id after a
      // durable retry. A host targets the in-flight attempt by THIS id, so it is
      // the one reported to the engine; it also marks the attempt as live, which
      // durable recovery (which never fires the callback) is distinguished by.
      let activeExecutionId: RunId | undefined;
      const completed = yield* executeStableSubagentInBand({
        session: runScope.session,
        executionId: logicalExecutionId,
        parentExecutionId: run.executionId,
        signal: invocation.signal,
        onActiveExecutionId: (executionId) => {
          activeExecutionId = executionId;
          invocation.report?.({ childExecutionId: executionId });
        },
        prepare: () =>
          Effect.gen(function* () {
            const { configPayload, agentName } =
              yield* resolveWorkflowCallConfig(
                invocation,
                parent,
                defaultAgent,
                run.executionId,
              );
            // Surface the resolved child model so the engine can attach it to
            // this call's `agent:end` progress event.
            invocation.report?.({
              model: configPayload.model,
              agent: agentName,
            });
            return {
              configPayload,
              agentName,
              parentStreamId: run.executionId,
              session: runScope.session,
              approvalPromptsUnavailable: parent.approvalPromptsUnavailable,
              onApprovalPolicyDenial: parent.onApprovalPolicyDenial,
              runtimeUnavailableTools: parent.runtimeUnavailableTools,
              // The engine settles the owning phase onto the call options before
              // handing them here (declared task phase, else the phase active at
              // call time), so this is a single-owner read rather than a
              // reconstruction of the engine's rule.
              workflowPhase: invocation.options.phase,
              // Live inherited bypass values, matching LLM delegation: each
              // approval follows the parent's corresponding bypass. The run's own
              // stream inherits from the orchestrator, so nested delegation remains
              // transitive.
              onStreamResolved: (resolvedStreamId) => {
                configureDelegatedChildApprovals(
                  resolvedStreamId,
                  run.executionId,
                  'inherit',
                  runScope.session,
                );
              },
              onCost: (totalCostUsd) => {
                hooks?.onCost?.(invocation, totalCostUsd);
                // Stamp progressive spend onto the live snapshot attempt so a
                // failed/cancelled/retried attempt still shows what it consumed
                // even when execution never reaches the success path below.
                if (totalCostUsd !== undefined) {
                  invocation.report?.({ costUsd: totalCostUsd });
                }
              },
            };
          }),
      });
      const recovered = activeExecutionId === undefined;
      if (recovered) {
        // Durable recovery never fires onActiveExecutionId; re-attach the
        // known child id so /executions/{id} can navigate to the child that
        // supplied the result. The recovered marker keeps the id out of the
        // engine's skip/retry map; the recovered result is authoritative and
        // must stay uncontrollable.
        invocation.report?.({
          childExecutionId: completed.executionId,
          recovered: true,
        });
      }
      const { result } = completed;
      // Live physical attempts always charge the terminal result cost (covers
      // failed/cancelled outcomes and empty-output validation throws that
      // never reach a success-only callback). Recovered durable results must
      // not charge the synthetic resume attempt; the interrupted snapshot may
      // already hold the same cost on a closed prior attempt.
      if (!recovered) {
        invocation.report?.({ costUsd: result.cost });
      }
      if (result.outcome !== 'completed') {
        throw new Error(
          `Workflow subagent ended with ${result.outcome} outcome.`,
        );
      }
      if (result.category === 'workflow' && result.outputs.length === 0) {
        throw new Error(
          'Workflow subagent completed without producing any output files.',
        );
      }
      return result;
    },
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof SubagentDurabilityError
          ? new WorkflowRunAbortError(error.message, { cause: error })
          : ensureError(error),
      );
    }),
  );
}
