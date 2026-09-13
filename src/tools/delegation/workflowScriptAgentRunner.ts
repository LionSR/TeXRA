// Third-party imports
import { Cause, Effect, type Scope } from 'effect';

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
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  RUN_OUTCOME,
} from '@shared/schemas';
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

/**
 * Fence one attempt this call is about to advance past, against a resume, for
 * the rest of the call. Whether that attempt recorded no outcome or ended
 * failed/cancelled is not a difference the fence makes: a resumable snapshot
 * outlives a terminal row (`run.activate` after `run.end` means the run
 * started again), so every advance is decided under the fence.
 *
 * A resume has two owners to be fenced against, so the fence has two halves
 * and neither is redundant.
 *
 * `acquireClaims` answers another process. It is the same admission a
 * dead-owner takeover uses (`SessionRequests.decide`, `resumeRun`): it proves
 * the prior owner dead before moving the claim, so a host that reached this
 * child first holds the claim and this acquire is refused, while a host that
 * arrives afterwards finds the claim held here and refuses in its turn. It
 * cannot answer this process: the claim is keyed by owner, and a row this
 * owner already holds is reclaimable, so a resume started in this session
 * takes the same claim without conflict.
 *
 * `holdInactiveRun` answers this one. The run lane is the single in-process
 * authority for "a generation of this run is live here" — the one
 * `resumeRun` consults through `isActiveOrResuming` — so a resume already
 * under way holds it and this hold is refused, and a resume that starts after
 * it finds the run held and refuses in its turn.
 *
 * Together they are what makes the terminal re-read under them final:
 * without them a resume can append `run.activate` between the reading and the
 * launch, and the probe starts a second child beside a running one.
 *
 * Both are released with the call's scope, which the engine owns and closes
 * only once the call's value is journaled: a superseded attempt stays fenced
 * for as long as its replacement is live, and the attempt whose result the
 * parent journals — recovered, or launched by this call and returned once its
 * loop released both — stays fenced until that result is durable. A claim
 * release that fails leaves every fact committed and only the claim behind, so
 * it is logged rather than failing a call whose child already answered.
 */
const fenceSupersededRun = (
  session: InBandSubagentLaunchOptions['session'],
  runId: RunId,
): Effect.Effect<void, Error, Scope.Scope> =>
  Effect.gen(function* () {
    yield* session.runs
      .holdInactiveRun(runId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowRunAbortError(
              `Workflow child ${runId} is live in this session; refusing to repeat it.`,
              { cause },
            ),
        ),
      );
    yield* Effect.acquireRelease(
      session
        .acquireClaims(qualifyAggregateId('run', runId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowRunAbortError(
                `Workflow child ${runId} could not be claimed against a concurrent resume; refusing to repeat it.`,
                { cause },
              ),
          ),
        ),
      (release) =>
        release.pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                `Workflow child ${runId} kept its claim after the call that fenced it: ${formatError('claim release failed', error)}`,
              );
            }),
          ),
        ),
    );
  });

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
 * before committing it and marks a lost drain on the row it decided, so a
 * COMPLETED row can never outlive facts the child queued.
 *
 * The probe starts at attempt 0 always, and every id that exists is inspected
 * in order: this process can have journaled a mark for `n` and died before
 * launching it, leaving the dead fence on `n-1` reclaimable, and another host
 * can have resumed `n-1` to a completed result since. Starting at the mark
 * would repeat that child's model work and its edits. A call reaches a second
 * attempt only when the first one closed without answering, so the ids below
 * the mark are a handful of aggregate reads set against a whole child run.
 *
 * The parent's journal answers one question only: what an id that reads back
 * as *nothing* means. The attempt mark it moves before each launch outlives
 * the children, and that mark is nullable, so the two answers are read
 * differently: no mark means the call never launched, so the first absent id
 * is the launch slot; a mark of `n` means attempt `n` launched, so an absent
 * id at or below `n` is one deletion has collected and the probe advances past
 * it, while the first absent id above `n` is the launch slot. An id the user
 * deleted is closed, not free: its tombstone is final, so the probe advances
 * past it, and once deletion collects that tombstone the mark is what still
 * says the call got that far.
 *
 * A run with no `run.end` for the lifecycle in flight, whose lease no live
 * owner still holds, frees the next attempt id in either of two shapes: it
 * settled no `child.turn`, so it never reached side-effectful work; or it
 * committed its `run.result` manifest and died in the one transaction before
 * `run.end`, so nothing will ever record that outcome. A settled turn without
 * a manifest is the one irreconcilable shape, and a live owner always refuses.
 *
 * One rule covers every id that already exists, whatever it recorded: it is
 * inspected while this call holds the attempt's own run lane and run claim,
 * and its terminal row is read again under that fence before anything is
 * decided from it. A terminal row closes nothing — a resumable snapshot
 * outlives it for a completed attempt exactly as it does for a failed one, and
 * `run.activate` after `run.end` means the run started again — so recovering
 * a completed result, advancing past an attempt, and refusing one are the same
 * decision taken from the same fenced reading, and neither a local resume nor
 * one in another process can start the child between that reading and what
 * follows it. Launching an id that never started takes no fence going in —
 * there is nothing yet for a resume to claim — and takes the same one coming
 * out, because the loop released the claim and the lane before it returned:
 * every attempt whose result the parent journals, recovered or just launched,
 * is held from the reading it is taken from until that journal commits. A row
 * marked `artifact-drain` is the one terminal outcome no attempt advances
 * past, whatever else it says: what that child did is unrecorded rather than
 * failed.
 *
 * A journal hit never reaches here: the engine consumes it before calling.
 */
const recoverOrLaunchWorkflowChild = Effect.fn('recoverOrLaunchWorkflowChild')(
  function* (
    call: WorkflowChildCall,
  ): Effect.fn.Return<
    WorkflowChildOutcome,
    Error,
    AgentRunServices | Scope.Scope
  > {
    const { session } = call;
    yield* Effect.try({
      try: () => call.signal?.throwIfAborted(),
      catch: ensureError,
    });
    // The mark does not say where to start; it says what an absent id means. A
    // deleted attempt is collected in the end, and an id-by-id probe reads the
    // hole that leaves as an id that never started — it would launch into it
    // and never reach the attempt that answered this call after it. The mark
    // is nullable because attempt 0 is an attempt: `null` is the only answer
    // that means nothing ever launched, so a journaled 0 whose child is gone
    // is advanced past rather than run a second time.
    const journaled = yield* probeJournal(
      call.key,
      readWorkflowCallAttempt(session, call.checkpointId, call.key),
    );
    for (let attempt = 0; attempt < MAX_WORKFLOW_CALL_ATTEMPTS; attempt += 1) {
      const runId = workflowCallRunId({
        parentRunId: call.parentRunId,
        checkpointId: call.checkpointId,
        key: call.key,
        attempt,
      });
      const records = getRunRecords(session, runId);
      if (!(yield* probeChild(runId, records.exists()))) {
        // An absent id at or below the mark is one the parent journaled a
        // launch for and deletion has since collected outright: nothing of it
        // reads back, but it ran, so the probe advances past it exactly as it
        // does past a tombstone. Only an id above the mark is a free slot.
        if (journaled !== null && attempt <= journaled) continue;
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
        // The child's loop released its claim and its run lane as it ended, so
        // from this return until the engine journals the call's value the id
        // it answered on is resumable: a host that takes it appends
        // `run.activate` and does more model work and more edits while the
        // parent commits a result read from the lifecycle before it. Take the
        // same fence every other exit takes, and read the terminal row under
        // it: a resume already under way holds the claim or the lane and is
        // refused here, and one that ran to its own end leaves a row this
        // reading no longer recognizes (an activate after the row reads as no
        // terminal row at all).
        yield* fenceSupersededRun(session, runId);
        const launched = yield* probeChild(runId, records.readRunEnd());
        // The outcome does not identify the lifecycle: a resume that reached
        // its own end usually ends `completed`, exactly as this one did, so a
        // terminal row that agrees with the result can belong to a lifecycle
        // this call never saw — with its own model work and its own edits.
        // The activation count is that identity. This call launched into an
        // id `exists()` read as absent, so the lifecycle it holds a result for
        // is the run's first and only, and every resume appends one more
        // `run.activate`. A second one means the result in hand describes a
        // lifecycle the run has already left.
        const activations = yield* probeChild(
          runId,
          records.countActivations(),
        );
        if (activations !== 1 || launched?.outcome !== result.outcome) {
          return yield* Effect.fail(
            new WorkflowRunAbortError(
              `Workflow child ${runId} started again before its result was journaled; refusing to report it.`,
            ),
          );
        }
        return { runId, result, recovered: false };
      }
      // Terminal for the lifecycle in flight, not for the aggregate: a
      // `run.activate` after a `run.end` means the run started again. This
      // copy therefore decides nothing; it only says whether the attempt owes
      // a liveness proof before the claim below is taken.
      if ((yield* probeChild(runId, records.readRunEnd())) === null) {
        // The claim is the liveness authority: only a run nobody alive owns
        // may have its attempt number advanced. An unreadable claim reports
        // unsettled, so this refuses rather than repeating the work. It is
        // asked before the fence, because the claim the fence takes reads back
        // as an owner of this run's own.
        const liveness = yield* resolveRunLiveness(runId, session, null);
        if (liveness.kind !== 'interrupted') {
          return yield* Effect.fail(
            new WorkflowRunAbortError(
              `Workflow child ${runId} recorded no outcome and is ${livenessClause(liveness)}; refusing to repeat it.`,
            ),
          );
        }
      }
      // Fence the attempt before deciding anything, whatever it recorded: a
      // free lease, and a terminal row of any outcome, each say only what was
      // true when they were read, and a completed row is resumable too, so
      // every decision below has to hold against a resume that starts one
      // instant later, here or in another process.
      yield* fenceSupersededRun(session, runId);
      // One read order, terminal row last: a child commits `run.end` before it
      // releases its claim, so a free claim makes that row final, while the
      // copy read before the claim was observed can predate a child that ended
      // — or started again — in between. Reading it here — under the fence, so
      // no new owner can be starting — is what makes it the row this call
      // recovers, advances past, or refuses on. It needs no activation count
      // beside it, unlike the launch exit above: the result recovered here is
      // built from this reading and the manifest read under the same fence,
      // never from a lifecycle observed before it, so there is no earlier
      // result a later row of the same outcome could be mistaken for.
      const end = yield* probeChild(runId, records.readRunEnd());
      if (end?.error?.kind === 'artifact-drain') {
        // The row says the attempt's queued facts rolled back, so what it did
        // is unknown rather than failed: repeating it could duplicate work
        // whose record is simply gone. The marker outranks the outcome beside
        // it — a stop that reached the run reports CANCELLED over the same
        // lost drain — which is the verdict the in-band caller reaches on the
        // same marker, and the outer boundary turns it into the abort that
        // keeps it out of the engine's nullable call result.
        return yield* Effect.fail(
          new SubagentDurabilityError(
            `Workflow child ${runId} failed to commit its final artifacts.`,
          ),
        );
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
      // Failed or cancelled with its facts intact: this attempt is closed and
      // repeating it is safe.
    }
    return yield* Effect.fail(
      new WorkflowRunAbortError(
        `Workflow call exceeded the ${MAX_WORKFLOW_CALL_ATTEMPTS} child-attempt limit.`,
      ),
    );
  },
);

/**
 * Build the production `agent()` adapter for one workflow-script run.
 *
 * The adapter takes its `Scope` from the engine rather than closing one of its
 * own around the call. The fences it holds over the attempt it recovered,
 * launched, or superseded have to outlive its return: the engine journals the
 * call's value after the runner answers, and a fence released at the return
 * leaves the inspected child free for a host to resume — appending
 * `run.activate` and doing more work — while the parent is still persisting
 * the result read from it. The engine closes that scope once the journal write
 * has committed.
 */
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
) => Effect.Effect<RunEnd, Error, AgentRunServices | Scope.Scope> {
  const { session } = parent.run;

  return Effect.fn('workflowScriptAgent')(
    function* (
      invocation: WorkflowAgentInvocation,
    ): Effect.fn.Return<RunEnd, Error, AgentRunServices | Scope.Scope> {
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
