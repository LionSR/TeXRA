// Third-party imports
import { Cause, Effect } from 'effect';

// Local imports
import { WorkflowRunAbortError } from '@agent/workflowScript/runWorkflowScript';
import type { WorkflowAgentInvocation } from '@agent/workflowScript/types';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { AgentRunServices } from '@agent/runtime/toolInjection';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { formatError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import type { AppState } from '@platform/interfaces';
import type { Secrets } from '@platform/secrets';
import { AgentCategory } from '@shared/schemas';
import type { RunEnd, RunId } from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { ensureError } from '@utils/errors/errorMessage';
import { deriveRunId } from '@utils/core/idHash';

// Local file imports
import { executeStableSubagentInBand } from './inBandSubagentRun';
import { SubagentDurabilityError } from './stableSubagentAttempt';
import {
  resolveInvocationFileList,
  rejectOversizedBibAttachments,
} from './inputFields';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { requireVisibleAgent, type DelegationParent } from './proposalFlow';

const log = createLog('workflowScriptAgentRunner');

function workflowScriptModelSelection(
  invocation: Pick<WorkflowAgentInvocation, 'options'>,
  parent: DelegationParent,
): Effect.Effect<string, Error, Secrets | AppState> {
  const requestedModel = invocation.options.model;
  return selectAvailableDelegationModel({
    ...(requestedModel !== undefined && { requestedModel }),
    parentModel: parent.model,
    withScope: parent.inScope,
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
 * `runId` is derived deterministically from the checkpoint identity, so
 * the grandchild run ids and run-storage lineage stay consistent when a
 * timed-out run is resumed under the same `meta.name`.
 */
interface WorkflowRunIdentity {
  readonly runId: RunId;
}

/**
 * Resolve what one issued `agent()` call actually runs; agent, model, result
 * contract, and files; from the options the script declared.
 */
const resolveWorkflowCallConfig = Effect.fn('resolveWorkflowCallConfig')(
  function* (
    call: Pick<WorkflowAgentInvocation, 'prompt' | 'options'>,
    parent: DelegationParent,
    defaultAgent: AgentEntry,
    runId: RunId,
  ): Effect.fn.Return<
    { configPayload: AgentConfigPayload; agentName: string },
    Error,
    Secrets | AppState
  > {
    const { session } = parent.run;
    const sharedConfigFields = {
      instruction: call.prompt,
      ...(parent.workingDirectory !== undefined && {
        workingDirectory: parent.workingDirectory,
      }),
      ...(parent.delegationAgentScope && {
        delegationAgentScope: parent.delegationAgentScope,
      }),
    };
    let configPayload: AgentConfigPayload;
    let agentName: string;

    if (call.options.schema !== undefined) {
      const requestedAgentName = call.options.agentName;
      if (requestedAgentName === undefined) {
        throw new WorkflowRunAbortError(
          'A structured workflow call must name a tool-use agent.',
        );
      }
      const agent = parent.inScope(() =>
        requireVisibleAgent(
          AgentCategory.ToolUse,
          requestedAgentName,
          parent.delegationAgentScope ?? undefined,
        ),
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
      const requestedAgentName = call.options.agentName;
      const agent =
        requestedAgentName === undefined
          ? defaultAgent
          : parent.inScope(() =>
              requireVisibleAgent(
                AgentCategory.Workflow,
                requestedAgentName,
                parent.delegationAgentScope ?? undefined,
              ),
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
          session,
          runId,
          'Input file',
          call.options.inputFiles ?? [],
        ),
        resolveInvocationFileList(
          session,
          runId,
          'Context file',
          call.options.contextFiles ?? [],
        ),
        resolveInvocationFileList(
          session,
          runId,
          'Media file',
          call.options.mediaFiles ?? [],
        ),
      ]);
      const inputFiles = inputs.map(({ file }) => file);
      const contextFiles = context.map(({ file }) => file);
      const mediaFiles = media.map(({ file }) => file);
      const oversizedBibRejection = yield* Effect.tryPromise({
        try: () =>
          parent.inScope(() => rejectOversizedBibAttachments(contextFiles)),
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
  parent: DelegationParent,
  defaultAgent: AgentEntry,
  checkpointId: string,
  run: WorkflowRunIdentity,
  hooks?: {
    /** Fires per live child on success and failure with its total cost. */
    readonly onCost?: (
      invocation: WorkflowAgentInvocation,
      costUsd: number | undefined,
    ) => void;
  },
): (
  invocation: WorkflowAgentInvocation,
) => Effect.Effect<RunEnd, Error, AgentRunServices> {
  const { session } = parent.run;

  return Effect.fn('workflowScriptAgent')(
    function* (
      invocation: WorkflowAgentInvocation,
    ): Effect.fn.Return<RunEnd, Error, AgentRunServices> {
      const logicalRunId = deriveRunId({
        checkpointId,
        key: invocation.key,
        parentRunId: run.runId,
      });
      // The id this attempt actually runs (and registers its child stream)
      // under: the logical id on attempt 0, an attempt-specific id after a
      // durable retry. A host targets the in-flight attempt by THIS id, so it is
      // the one reported to the engine; it also marks the attempt as live, which
      // durable recovery (which never fires the callback) is distinguished by.
      let activeRunId: RunId | undefined;
      const completed = yield* executeStableSubagentInBand({
        session,
        runId: logicalRunId,
        parentRunId: run.runId,
        signal: invocation.signal,
        onActiveRunId: (runId) => {
          activeRunId = runId;
          invocation.report({ childRunId: runId });
        },
        prepare: () =>
          Effect.gen(function* () {
            const { configPayload, agentName } =
              yield* resolveWorkflowCallConfig(
                invocation,
                parent,
                defaultAgent,
                run.runId,
              );
            // Surface the resolved child model so the engine can attach it to
            // this call's `agent:end` progress event.
            invocation.report({
              model: configPayload.model,
              agent: agentName,
            });
            return {
              configPayload,
              agentName,
              parentRunId: run.runId,
              session,
              approvalPromptsUnavailable:
                parent.run.toolPolicy.approvalPromptsUnavailable,
              onApprovalPolicyDenial: parent.onApprovalPolicyDenial,
              runtimeUnavailableTools:
                parent.run.toolPolicy.runtimeUnavailableTools,
              // The engine settles the owning phase onto the call options before
              // handing them here (declared task phase, else the phase active at
              // call time), so this is a single-owner read rather than a
              // reconstruction of the engine's rule.
              workflowPhase: invocation.options.phase,
              // Live inherited bypass values, matching LLM delegation: each
              // approval follows the parent's corresponding bypass. The run's own
              // stream inherits from the orchestrator, so nested delegation remains
              // transitive.
              onRunResolved: (resolvedRunId) => {
                configureDelegatedChildApprovals(
                  resolvedRunId,
                  run.runId,
                  'inherit',
                  session,
                );
              },
              onCost: (costUsd) => {
                hooks?.onCost?.(invocation, costUsd);
                // Stamp progressive spend onto the live snapshot attempt so a
                // failed/cancelled/retried attempt still shows what it consumed
                // even when run never reaches the success path below.
                if (costUsd !== undefined) {
                  invocation.report({ costUsd: costUsd });
                }
              },
            };
          }),
      });
      const recovered = activeRunId === undefined;
      if (recovered) {
        // Durable recovery never fires onActiveRunId; re-attach the
        // known child id so /executions/{id} can navigate to the child that
        // supplied the result. The recovered marker keeps the id out of the
        // engine's skip/retry map; the recovered result is authoritative and
        // must stay uncontrollable.
        invocation.report({
          childRunId: completed.runId,
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
        // `RunEnd.usage` is present once a round recorded usage and absent
        // otherwise (see `RunEndSchema`), so it stays optional and absence is
        // the recorded fact "no spend" rather than an unknown defaulted here.
        invocation.report({ costUsd: result.usage?.totalCost ?? 0 });
      }
      if (result.outcome !== 'completed') {
        throw new Error(
          `Workflow subagent ended with ${result.outcome} outcome.`,
        );
      }
      if (
        result.output.category === 'workflow' &&
        result.output.outputs.length === 0
      ) {
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
