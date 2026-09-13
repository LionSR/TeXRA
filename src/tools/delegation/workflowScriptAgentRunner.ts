// Third-party imports
import { Cause, Effect } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import {
  readWorkflowCallAttempt,
  recordWorkflowCallAttempt,
} from '@agent/workflowScript/checkpoint';
import { WorkflowRunAbortError } from '@agent/workflowScript/runWorkflowScript';
import type { WorkflowAgentInvocation } from '@agent/workflowScript/types';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { AgentRunServices } from '@agent/runtime/toolInjection';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { formatError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import type { AppState } from '@platform/interfaces';
import type { Secrets } from '@platform/secrets';
import { AgentCategory, RUN_OUTCOME } from '@shared/schemas';
import type { RunEnd, RunId } from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import {
  resolveRunLiveness,
  type RunLiveness,
} from '@tools/executions/runLiveness';
import { ensureError } from '@utils/errors/errorMessage';
import { deriveRunId } from '@utils/core/idHash';

// Local file imports
import {
  executeSubagentInBand,
  SubagentDurabilityError,
  type InBandSubagentLaunchOptions,
} from './inBandSubagentRun';
import {
  resolveInvocationFileList,
  rejectOversizedBibAttachments,
} from './inputFields';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { requireVisibleAgent, type DelegationParent } from './proposalFlow';

const log = createLog('workflowScriptAgentRunner');

function workflowRunnerError(error: unknown): Error {
  return error instanceof SubagentDurabilityError
    ? new WorkflowRunAbortError(error.message, { cause: error })
    : ensureError(error);
}

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

/**
 * The run one workflow `agent()` attempt executes under.
 *
 * Uniform across attempts: attempt 0 has no special case, so the logical call
 * identity stays a journal key and is never itself a run id. `checkpointId` is
 * in the preimage for more than uniqueness: the whole invocation runs under
 * that checkpoint's own lane, which is what serializes two dispatches of one
 * call. A caller that keys a call on anything but the checkpoint loses that
 * serialization silently.
 */
function workflowCallRunId(call: {
  /** The workflow-script run that owns the call. */
  readonly parentRunId: RunId;
  /** The durable journal identity. */
  readonly checkpointId: string;
  /** The engine's prompt + options + dependency hash. */
  readonly key: string;
  /** 0-based physical attempt. */
  readonly attempt: number;
}): RunId {
  return deriveRunId({
    attempt: call.attempt,
    checkpointId: call.checkpointId,
    key: call.key,
    parentRunId: call.parentRunId,
  });
}

/** Why a started child may not have its attempt number advanced. */
function livenessClause(liveness: RunLiveness): string {
  switch (liveness.kind) {
    case 'unsettled':
      return liveness.reason;
    case 'live':
      return 'still running in this process';
    case 'settled':
      return `recorded as ${liveness.outcome}`;
    case 'interrupted':
      return 'interrupted';
  }
}

/**
 * A storage fault while inspecting a child is not this call's own failure: the
 * engine turns a failed call into a `null` the script can swallow, so an
 * unreadable child aggregate has to abort the run rather than read as a child
 * that answered nothing.
 */
function probeChild<A>(
  runId: RunId,
  read: Effect.Effect<A, Error>,
): Effect.Effect<A, Error> {
  return read.pipe(
    Effect.mapError(
      (cause) =>
        new WorkflowRunAbortError(
          `Workflow child ${runId} could not be inspected.`,
          { cause },
        ),
    ),
  );
}

/**
 * The parent's own journal is read on the same rule: a checkpoint this call
 * cannot read or move is a durability fault, not a call that answered
 * nothing.
 */
function probeJournal<A>(
  key: string,
  read: Effect.Effect<A, Error>,
): Effect.Effect<A, Error> {
  return read.pipe(
    Effect.mapError(
      (cause) =>
        new WorkflowRunAbortError(
          `Workflow call ${key} could not read or move its attempt mark.`,
          { cause },
        ),
    ),
  );
}

/** Runaway backstop on the attempt probe, not a retry policy. */
const MAX_WORKFLOW_CALL_ATTEMPTS = 1_024;

interface WorkflowChildOutcome {
  readonly runId: RunId;
  readonly result: RunEnd;
  /** The result came from a child that had already run; nothing ran now. */
  readonly recovered: boolean;
}

type WorkflowChildCall = Omit<InBandSubagentLaunchOptions, 'runId'> & {
  readonly checkpointId: string;
  readonly key: string;
  /** Fires with the run id of the attempt about to run; recovery never fires. */
  readonly onLaunch: (runId: RunId) => void;
};

/**
 * Resolve one `agent()` call against the child runs it already has, then
 * launch only if none of them answered it. The child's own aggregate is the
 * fact: `run.start` is the launch edge, and a `run.result` manifest under a
 * COMPLETED `run.end` is durable completion, because the terminal row is the
 * post-drain fact — `finalizeRunTerminal` settles the ordered publisher
 * before committing it and records a lost drain as a FAILED outcome, so a
 * COMPLETED row can never outlive facts the child queued.
 *
 * Which ids to probe comes from the parent's journal: the attempt mark it
 * moves before each launch outlives the children, so the probe starts at the
 * attempt that ran rather than at 0. An id the user deleted is closed, not
 * free: its tombstone is final, so the probe advances past it, and once
 * deletion collects that tombstone the mark is what still says the call got
 * that far.
 *
 * A run with no `run.end` for the lifecycle in flight, whose lease no live
 * owner still holds, frees the next attempt id in either of two shapes: it
 * settled no `child.turn`, so it never reached side-effectful work; or it
 * committed its `run.result` manifest and died in the one transaction before
 * `run.end`, so nothing will ever record that outcome. A settled turn without
 * a manifest is the one irreconcilable shape, and a live owner always refuses.
 *
 * A journal hit never reaches here: the engine consumes it before calling.
 */
const recoverOrLaunchWorkflowChild = Effect.fn('recoverOrLaunchWorkflowChild')(
  function* (
    call: WorkflowChildCall,
  ): Effect.fn.Return<WorkflowChildOutcome, Error, AgentRunServices> {
    const { session } = call;
    yield* Effect.try({
      try: () => call.signal?.throwIfAborted(),
      catch: ensureError,
    });
    // Where the probe starts: the parent's journal, not attempt 0. A deleted
    // attempt is collected in the end, and an id-by-id probe reads the hole
    // that leaves as an id that never started — it would launch into it and
    // never reach the attempt that answered this call after it.
    const launched = yield* probeJournal(
      call.key,
      readWorkflowCallAttempt(session, call.checkpointId, call.key),
    );
    for (
      let attempt = launched;
      attempt < launched + MAX_WORKFLOW_CALL_ATTEMPTS;
      attempt += 1
    ) {
      const runId = workflowCallRunId({
        parentRunId: call.parentRunId,
        checkpointId: call.checkpointId,
        key: call.key,
        attempt,
      });
      const records = getRunRecords(session, runId);
      if (!(yield* probeChild(runId, records.exists()))) {
        // `exists()` is false for an id that never started AND for one the
        // user deleted, and a tombstone is final: launching a deleted id is
        // refused by its own sequence, and the attempt that answered this call
        // after it would never be probed. A deleted attempt is therefore
        // closed like any other terminal one and the probe moves on.
        if (yield* probeChild(runId, records.isRemoved())) continue;
        // Move the parent's attempt mark before anything runs under this id:
        // the journal outlives every child, so whatever becomes of this
        // attempt's aggregate, a resume still starts its probe here.
        yield* probeJournal(
          call.key,
          recordWorkflowCallAttempt(
            session,
            call.checkpointId,
            call.key,
            attempt,
          ),
        );
        // Publish the attempt id before resolving mutable launch state: a host
        // targets the in-flight child by this id.
        call.onLaunch(runId);
        const { result } = yield* executeSubagentInBand({
          session,
          runId,
          parentRunId: call.parentRunId,
          signal: call.signal,
          prepare: call.prepare,
        });
        return { runId, result, recovered: false };
      }
      // Terminal for the lifecycle in flight, not for the aggregate: a
      // `run.activate` after a `run.end` means the run started again.
      let end = yield* probeChild(runId, records.readRunEnd());
      if (end === null) {
        // The claim is the liveness authority: only a run nobody alive owns
        // may have its attempt number advanced. An unreadable claim reports
        // unsettled, so this refuses rather than repeating the work.
        const liveness = yield* resolveRunLiveness(runId, session, null);
        if (liveness.kind !== 'interrupted') {
          return yield* Effect.fail(
            new WorkflowRunAbortError(
              `Workflow child ${runId} recorded no outcome and is ${livenessClause(liveness)}; refusing to repeat it.`,
            ),
          );
        }
        // One read order, terminal row last: a child commits `run.end` before
        // it releases its claim, so a free claim makes that row final, while
        // the copy read before the claim was observed can predate a child that
        // ended in between. Reading it again here is what stops a run that
        // finished mid-probe from being repeated.
        end = yield* probeChild(runId, records.readRunEnd());
      }
      if (end === null) {
        const turns = yield* probeChild(
          runId,
          readChildTurnState(session, runId),
        );
        if (turns.lastCompleted !== null) {
          // A settled turn under a `producer: 'subagent'` manifest is the one
          // transaction between `run.result` and `run.end`: the child got as
          // far as committing its result and died, and nothing will ever write
          // that `run.end`, so this attempt is closed like any other terminal
          // one. Without a manifest the child settled work nothing recorded.
          const meta = yield* probeChild(runId, records.readResultMeta());
          if (meta?.producer !== 'subagent') {
            return yield* Effect.fail(
              new WorkflowRunAbortError(
                `Workflow child ${runId} settled a turn but recorded no outcome; refusing to repeat it.`,
              ),
            );
          }
        }
        // Dead owner, and nothing left that could still record an outcome.
        continue;
      }
      if (end.outcome === RUN_OUTCOME.COMPLETED) {
        const meta = yield* probeChild(runId, records.readResultMeta());
        if (meta?.producer !== 'subagent') {
          return yield* Effect.fail(
            new WorkflowRunAbortError(
              `Workflow child ${runId} completed without a result manifest; refusing to repeat it.`,
            ),
          );
        }
        yield* Effect.try({
          try: () => call.signal?.throwIfAborted(),
          catch: ensureError,
        });
        return {
          runId,
          result: { ...end, output: meta.output },
          recovered: true,
        };
      }
      // Failed or cancelled: this attempt is closed and repeating is safe.
    }
    return yield* Effect.fail(
      new WorkflowRunAbortError(
        `Workflow call exceeded the ${MAX_WORKFLOW_CALL_ATTEMPTS} child-attempt limit.`,
      ),
    );
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
      const child = yield* recoverOrLaunchWorkflowChild({
        session,
        parentRunId: run.runId,
        checkpointId,
        key: invocation.key,
        signal: invocation.signal,
        onLaunch: (childRunId) => {
          invocation.report({ childRunId });
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
      const { recovered, result } = child;
      if (recovered) {
        // Recovery never launched, so the id was never reported; attach it now
        // so /executions/{id} can navigate to the child that supplied the
        // result. The recovered marker keeps the id out of the engine's
        // skip/retry map; a recovered result is authoritative and must stay
        // uncontrollable.
        invocation.report({
          childRunId: child.runId,
          recovered: true,
        });
      }
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
      if (Cause.hasInterrupts(cause)) {
        return Effect.failCause(Cause.map(cause, workflowRunnerError));
      }
      return Effect.fail(workflowRunnerError(Cause.squash(cause)));
    }),
  );
}
