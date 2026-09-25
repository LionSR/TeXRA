import * as path from 'node:path';

import { Cause, Effect, Exit, Fiber, Layer } from 'effect';

import { logConversationProgress, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { acquireResumedRunOwnership } from '@agent/storage/runLifecycle';
import { persistedParentRunId } from '@agent/storage/runRecords';
import { AgentError } from '@common/errors';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  type ModelCompatibilityKey,
  type RunId,
  type RequestEnsureProgressViewPayload,
  type RunOutcome,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  AgentCategory,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import type { CompositionKey } from '@tools/compositions';
import { ensureError } from '@utils/errors/errorMessage';
import { ensureRunDirUnder } from '@utils/files/runStorageFs';

import {
  buildAgentLaunchContext,
  prepareAgentDefinition,
  type PreparedAgentDefinition,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import {
  runFlowWithLifecycle,
  type RunFlowLifecycleOptions,
} from './AgentRunLifecycle';
import {
  type AgentFlowResult,
  type WorkflowFlowResult,
} from './AgentFlowResult';
import { generateSessionDescription } from './sessionDescription';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import { followUpsLayer } from './FollowUps';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer } from './run/AgentRun';
import { runReflection } from './loop/reflection';
import { runToolUse } from './loop/toolUse';
import { Runs } from './runRegistry';
import type { AgentRunServices } from './runRegistry';
import type { SessionHandle } from './SessionHandle';
import type { RunHandle, AgentRunHandle } from './RunHandle';

const CHANNEL = 'executeAgent';

/** A claimed run no longer has the persisted tool-use state to resume. */
export class ResumeSessionUnavailableError extends Error {
  constructor(readonly runId: RunId) {
    super('This session can no longer be resumed. Start a new run instead.');
    this.name = 'ResumeSessionUnavailableError';
  }
}

/**
 * The wiring the two tool-use entry points genuinely do not share. Everything
 * outside this union is assembled once in {@link launchToolUseRun}, so a field
 * added for one entry point cannot go missing on the other.
 */
type ToolUseLaunchVariant =
  | {
      readonly kind: 'fresh';
      readonly onIdle?: (state: RunState) => void;
    }
  | {
      readonly kind: 'resume';
      readonly resume: ToolUseResumeData;
      readonly onIdle?: (state: RunState) => void;
      /** Queried once the resumed flow is attached and interruptible. */
      readonly isCancellationRequested?: () => boolean;
      readonly onCancellationAtFlowAttachment?: () => void;
    };

/**
 * The per-run layer both families run under: the run's `AgentRun`, the
 * invoker, the session's ledger, and the session's rooted filesystems (built
 * from the roots of the session the run is on, fresh or resumed, so code
 * below the launch takes `WorkspaceFs` / `StorageFs` from context rather than
 * from the fiber's ambient roots). The follow-up lease is not here: only
 * the tool-use loop consumes a queue and only its finalizer releases the
 * lease, so building `followUpsLayer` for a workflow run would claim a live
 * consumer nothing ever releases — later submissions would report as
 * delivered live to a run that has ended.
 */
function runLayerFor(
  ctx: AgentLaunchContext,
  shared: SubagentRunOptions,
  onIdle: ((state: RunState) => void) | undefined,
) {
  const runSession = ctx.session;
  return modelInvokerLayer().pipe(
    Layer.provideMerge(
      agentRunLayer(ctx, {
        tools: shared.tools,
        onApprovalPolicyDenial: shared.onApprovalPolicyDenial,
        callbacks: {
          onProgress: (update) => {
            if (update.kind === 'overview') {
              logConversationProgress(ctx.logger, {
                toolCallCount: update.toolCallCount,
              });
            }
            shared.onProgress?.(update);
          },
          ...(onIdle ? { onIdle } : {}),
        },
      }),
    ),
    Layer.provideMerge(Layer.succeed(RunLedger)(runSession.ledger)),
    Layer.provideMerge(sessionFsLayer(runSession.roots)),
  );
}

/**
 * Run the tool-use loop for a single agent run, fresh or resumed.
 *
 * Owns all tool-use-specific wiring: progress counters, follow-up queuing, and
 * model-change side effects. A failed run arrives as a FAILED result carrying
 * its structured error, so there is nothing to unwrap here.
 * The callers (`executeAgent`, `resumeToolUseFromResumeData`) own lifecycle and
 * stream-status; this function owns only what is specific to the ToolUse
 * category.
 */
function launchToolUseRun(
  ctx: AgentLaunchContext,
  handle: RunHandle,
  shared: SubagentRunOptions,
  variant: ToolUseLaunchVariant,
): Effect.Effect<AgentFlowResult, Error, AgentRunServices> {
  const { runId } = ctx;
  const toResult = (
    result: Effect.Success<ReturnType<typeof runToolUse>>,
  ): AgentFlowResult => ({
    outcome: result.outcome,
    output: {
      category: 'toolUse',
      response: result.response,
      files: [...result.files],
      ...(result.structured !== undefined
        ? { structured: result.structured }
        : {}),
    },
    runId,
    usage: result.usage,
    ...(result.error ? { error: result.error } : {}),
    ...(ctx.attachedMemoryMisses.length
      ? { memoryMisses: ctx.attachedMemoryMisses }
      : {}),
  });
  const program = runToolUse({
    ...(shared.turns
      ? {
          turns: {
            turnPermit: shared.turns.turnPermit,
            onTurnBoundary: (result) =>
              shared.turns!.onTurnBoundary(toResult(result)),
          },
        }
      : {}),
    resume: variant.kind === 'resume',
    attachment: {
      attach: (flowContext) => {
        handle.attachToolUseFlow(flowContext);
        if (variant.kind === 'resume' && variant.isCancellationRequested?.()) {
          variant.onCancellationAtFlowAttachment?.();
          flowContext.interrupt();
        }
      },
      detach: (flowContext) => handle.detachToolUseFlow(flowContext),
    },
  }).pipe(
    Effect.provide(
      // The follow-up lease is the tool-use loop's alone; its finalizer is
      // what releases it.
      followUpsLayer.pipe(
        Layer.provideMerge(runLayerFor(ctx, shared, variant.onIdle)),
      ),
    ),
    Effect.map(toResult),
  );
  return program;
}

/**
 * Run the reflection loop for a single agent run, fresh or resumed. The
 * host's output finalization runs after the loop's result and may change the
 * verdict; a run that failed keeps its error.
 */
function launchReflectionRun(
  ctx: AgentLaunchContext,
  options: ExecuteAgentOptions,
): Effect.Effect<AgentFlowResult, Error, AgentRunServices> {
  const { runId } = ctx;
  const program = runReflection({ resume: options.resumed === true }).pipe(
    Effect.provide(runLayerFor(ctx, options, undefined)),
    Effect.flatMap((result) =>
      Effect.gen(function* () {
        const flowResult: WorkflowFlowResult = {
          outcome: result.outcome,
          output: {
            category: 'workflow',
            outputs: roundOutputsToOutputSummaries(result.roundOutputs),
            compileFailures: roundOutputsToCompileFailureSummaries(
              result.roundOutputs,
            ),
            diffs: [],
          },
          runId,
          usage: result.usage,
          ...(result.error ? { error: result.error } : {}),
          ...(ctx.attachedMemoryMisses?.length
            ? { memoryMisses: ctx.attachedMemoryMisses }
            : {}),
        };
        if (flowResult.error || !options.openWorkflowOutput) return flowResult;
        const outputOutcome = yield* options.openWorkflowOutput(
          flowResult,
          ctx.setting.defaultOutputFiles,
        );
        return outputOutcome === undefined
          ? flowResult
          : { ...flowResult, outcome: outputOutcome };
      }),
    ),
  );
  return options.turns ? options.turns.turnPermit(program) : program;
}

/**
 * The lifecycle options every entry point that drives one run passes. The
 * parent edge is an argument because resume reads it from the persisted
 * `run.start` rather than from the caller's options.
 */
function buildLifecycleOptions(
  options: SubagentRunOptions,
  parentRunId: RunId | undefined,
): RunFlowLifecycleOptions {
  return {
    parentRunId,
    onError: options.onRunError,
    onRun: options.onRun,
  };
}

/** Toast payload shown when the progress view cannot be opened. */
type FallbackNotification = NonNullable<
  RequestEnsureProgressViewPayload['fallbackNotification']
>;

function buildFallbackNotification(config: AgentConfig): FallbackNotification {
  const primaryInput = config.inputFiles[0];
  const inputName = primaryInput
    ? path.basename(primaryInput)
    : 'selected input';
  const outputFiles = config.outputFiles ?? [];
  let outputInfo = '';
  if (outputFiles.length > 1) {
    outputInfo = `to ${outputFiles.length} files`;
  } else if (outputFiles[0]) {
    outputInfo = `to ${path.basename(outputFiles[0])}`;
  }
  return {
    agentName: config.agent,
    modelName: config.model,
    inputName,
    outputInfo,
  };
}

/**
 * Callback and host-context fields shared by every entry point that drives one
 * subagent run (`executeAgent`, `resumeToolUseFromResumeData`, and
 * `resumeQueuedToolUseFromResumeData`). Extracted so the three option bags describing
 * the same run can't silently drift out of sync or re-declare the same field
 * under a different name.
 */
export interface SubagentRunOptions {
  /** The child-run policy: each turn's permit, each completed turn's boundary. */
  readonly turns?: import('./childRunLoop').ChildRunTurns<AgentFlowResult>;
  /** Run-scoped tools added to tool-use agents without mutating the default registry. */
  readonly tools?: readonly ITool[];
  /**
   * The launching run, for a delegated child: the parent edge on the handle,
   * the subagent prompt. A fresh launch takes it from the caller; a resume ignores it and
   * reads the persisted `run.start`.
   */
  parentRunId?: RunId;
  /** Fires on meaningful progress: todo changes and tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  approvalPromptsUnavailable?: boolean;
  /**
   * The composition a fresh delegated child joins: its parent's. A resume
   * resolves its own under the recorded-toolset rule.
   */
  composition?: CompositionKey;
  /** Record that this run met an approval-policy denial (see `AgentRun`). */
  onApprovalPolicyDenial?: (withheldTools?: readonly string[]) => void;
  /** Session owning this run's coordination state; run entry points require it. */
  session?: SessionHandle;
  /**
   * Fires when a subagent fails with a provider/runtime error that the caller
   * can report up the delegation chain. Outcome-only domain failures remain on
   * the returned result and do not manufacture an error for this callback.
   * Distinct from host-level resume-plumbing error surfaces. Synchronous by
   * contract; it reaches the run's terminal `deliver` guard.
   */
  onRunError?: (error: unknown, result: AgentFlowResult) => void;
  /** Fires once with the live per-run handle right after it is tracked (F-2). */
  onRun?: (handle: AgentRunHandle) => Effect.Effect<void, Error>;
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /**
   * Finalize a workflow's host-owned output while its run handle and durable
   * checkpoint are still live. A stop during this operation can therefore
   * preserve the checkpoint instead of interrupting an already-terminal run.
   * Return an outcome when output finalization changes the run's verdict.
   *
   * The run yields this program on the run's own fiber, so a stop reaches
   * it. A handler that needs a session-rooted fact (workspace config,
   * storage) reads it from the session it was given, not from the calling
   * fiber: nothing carries one.
   */
  openWorkflowOutput?: (
    result: WorkflowFlowResult,
    /**
     * The `defaultOutputFiles` declared by the definition this run loaded —
     * the only place a remote agent's are readable, and the run's own copy, so
     * a host never re-reads a catalog entry that may have been refreshed since
     * the launch.
     */
    agentDefaultOutputFiles: readonly string[],
  ) => Effect.Effect<RunOutcome | void, Error>;
  /**
   * The run's `run.start` was committed by an earlier activation (a resume).
   * That row is also where this run's parent edge comes from: `runAgent`
   * reads it onto the run's handle before this launch prepares, and a
   * resumed run takes its lineage from there, never from `parentRunId`.
   */
  resumed?: boolean;
  /**
   * Fires with the run id once its `run.start` is published, before the run
   * begins: the run exists for every fold, so a host may select it as its
   * own surface state. The run's trace comes with it, before its first
   * event, for a consumer that must hear every trace event.
   */
  onRunResolved?: (runId: RunId, trace: AgentTrace) => void;
  /** Fires at every cycle boundary — see `AgentRun.callbacks.onIdle`. */
  onIdle?: (state: RunState) => void;
  /** Stop a tool-use run after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelCompatibilityKey?: ModelCompatibilityKey | null;
  /** This launch is the user's own-API-key fallback for a quota-exhausted
   *  retry: it declines the Copilot route and every subscription route. */
  ownApiKeyFallback?: boolean;
}

/**
 * Low-level run runner for an already-registered run. Fresh
 * launches should use `runAgent()` or call `registerRun()` first so the
 * canonical configuration is committed with the run's creation.
 * Its prepared definition must be the one registration used. Resume paths reuse the existing run record.
 * The run is on `options.session`, and so are its `Runs`, provided here.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & { session: SessionHandle },
): Effect.Effect<AgentFlowResult, Error, ProcessServices> {
  return Effect.gen(function* () {
    // A resumed run's parentage is the persisted `run.start`, re-read by its
    // launcher inside the owned launch and handed in as `parentRunId` —
    // `runAgent` after its ownership re-read, `resumeToolUseWithOwnedLease`
    // from the same persisted read — never a caller's own word about which
    // run launched it. A detach another host committed while the launch
    // prepared has folded by then, so the edge arrives already severed.
    const ctx = yield* buildAgentLaunchContext({
      definition,
      runId,
      resumed: options.resumed,
      onRunResolved: options.onRunResolved,
      session: options.session,
      modelCompatibilityKey: options.modelCompatibilityKey,
      ownApiKeyFallback: options.ownApiKeyFallback,
      toolPolicy: {
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        stopAfterCycle: options.stopAfterCycle,
        // A resumed run resolves its own: its parent's pin is not recorded.
        composition: options.resumed ? undefined : options.composition,
      },
    });
    return yield* Effect.gen(function* () {
      const { setting, config } = ctx;
      const { runId, session: runSession } = ctx;

      // Start description generation concurrently with the run, but join it
      // before the owner can release its run lease. This prevents the
      // metadata write from recreating a run deleted by another host.
      // A child of the run's fiber, so the run's stop interrupts it, as it
      // interrupts the run.
      const sessionDescription = yield* Effect.forkChild(
        generateSessionDescription(
          runId,
          config,
          ctx.resolvedAgentDescription,
          runSession,
          ctx.stores,
        ),
      );
      // The join is `ensuring`, not a generator `finally`: the driver skips
      // a `finally` after a failed `yield*`, releasing the lease mid-write.
      return yield* Effect.gen(function* () {
        const result = yield* runFlowWithLifecycle(
          ctx,
          (handle) =>
            Effect.gen(function* () {
              // This run's lineage, derived once, from the live handle
              // the registry admitted: for a resume that is the edge
              // carried over from the provisional registration, minus a
              // detach committed while the launch prepared, and for a
              // fresh launch it is the caller's own parent.
              const parentRunId = handle.deliveryTarget;
              // Pre-run UI setup (RUNNING is set by runFlowWithLifecycle)
              yield* ensureRunDirUnder(runSession.roots.storage, runId);
              yield* Effect.logInfo(`Starting run (runId: ${runId})`).pipe(
                withLogChannel(CHANNEL),
              );
              yield* Effect.logInfo(
                `Input file: ${config.inputFiles[0] ?? '(none)'}`,
              ).pipe(withLogChannel(CHANNEL));
              yield* Effect.logDebug('Run details').pipe(
                Effect.annotateLogs({
                  data: {
                    runId,
                    agent: config.agent,
                    model: config.model,
                  },
                }),
                withLogChannel(CHANNEL),
              );
              yield* Effect.logDebug(
                `Output files: ${config.outputFiles?.length ?? 0}`,
              ).pipe(withLogChannel(CHANNEL));
              // Subagents don't need to force-open the progress board or show notifications;
              // the orchestrator's run is already visible.
              if (parentRunId === undefined) {
                yield* runSession.interactions.emit(
                  'requestEnsureProgressView',
                  {
                    fallbackNotification: buildFallbackNotification(config),
                  },
                  { replayWhenAttached: true },
                );
              }
              yield* Effect.logInfo('Executing agent').pipe(
                Effect.annotateLogs({
                  data: { agent: config.agent, model: config.model },
                }),
                withLogChannel(CHANNEL),
              );

              if (setting.agentCategory === AgentCategory.ToolUse) {
                return yield* launchToolUseRun(
                  ctx,
                  handle,
                  { ...options, parentRunId },
                  { kind: 'fresh', onIdle: options.onIdle },
                );
              }
              return yield* launchReflectionRun(ctx, {
                ...options,
                parentRunId,
              });
            }),
          // The edge the lifecycle's handle is born with: the caller's own
          // parent for a fresh child, the persisted `run.start` edge for a
          // resume, both carried in as `parentRunId`.
          buildLifecycleOptions(options, options.parentRunId),
        );
        return result;
      }).pipe(Effect.ensuring(Fiber.join(sessionDescription)));
    });
  }).pipe(
    // The run's scope: the launch acquires the run trace into it and the
    // finalizer drops its subscribers once the run has ended. No mask: the
    // launch's acquisitions settle atomically (`acquireRelease`), so an
    // interruption lands between steps and this scope's finalizers run.
    Effect.scoped,
    Effect.provideService(Runs, options.session.runs),
  );
}

/**
 * What a resumed turn is handed: which run, and the config it runs under.
 * The snapshot is not part of it — the turn reads it once, under the run
 * lease it just acquired, so no caller can hand in a stale one.
 */
export type ResumeTurnIdentity = Pick<
  ToolUseResumeData,
  'runId' | 'agentConfig'
>;

export interface ResumeToolUseFromResumeDataOptions extends SubagentRunOptions {
  /** A resumed cycle is idle after its child delivery, while its run stays live. */
  readonly onIdle?: (state: RunState) => void;
  /** Query caller-owned cancellation once the resumed flow is interruptible. */
  readonly isCancellationRequested?: () => boolean;
  /** Observe cancellation accepted at the live-flow attachment boundary. */
  readonly onCancellationAtFlowAttachment?: () => void;
}

/**
 * Resume one live tool-use scope from its durable cursor. Lineage comes from
 * `run.start.parent`, minus any committed `run.detach`.
 */
const resumeToolUseWithOwnedLease = Effect.fn('resumeToolUseWithOwnedLease')(
  function* (
    resume: ToolUseResumeData,
    options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
  ) {
    const runSession = options.session;
    // Every exit escapes this scope before the claim's release runs (the
    // scope `resumeToolUse` closes around this call): the launch's finalizers
    // compensate through the run's own claim - the stage's FAILED close is an
    // append - so a release that ran before them would have their
    // compensation refused `DatabaseNotOwner`.
    const outcome = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const parentRunId = yield* persistedParentRunId(
            runSession,
            resume.runId,
          );
          const definition = yield* prepareAgentDefinition({
            config: resume.agentConfig,
            enforceCategory: true,
            session: runSession,
            suppressErrorNotification: true,
          });
          const ctx = yield* buildAgentLaunchContext({
            definition,
            runId: resume.runId,
            resumed: true,
            modelCompatibilityKey: resume.modelCompatibilityKey,
            session: runSession,
            toolPolicy: {
              approvalPromptsUnavailable: options.approvalPromptsUnavailable,
            },
          });
          const { setting } = ctx;
          return yield* runFlowWithLifecycle(
            ctx,
            (handle) =>
              // Inside the lifecycle so the rejection ends the started stream
              // with its FAILED result like any other run failure.
              setting.agentCategory !== AgentCategory.ToolUse
                ? // Keep this historical diagnostic byte-for-byte for external monitors.
                  Effect.fail(
                    new AgentError(
                      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
                    ),
                  )
                : launchToolUseRun(
                    ctx,
                    handle,
                    { ...options, parentRunId },
                    {
                      kind: 'resume',
                      resume,
                      onIdle: options.onIdle,
                      isCancellationRequested: options.isCancellationRequested,
                      onCancellationAtFlowAttachment:
                        options.onCancellationAtFlowAttachment,
                    },
                  ),
            buildLifecycleOptions(options, parentRunId),
          );
        }),
      ),
    );
    // The claim's release is no longer this function's: it rides the scope
    // `resumeToolUse` closes around this call, and for a recovered child the
    // driver owns delivery and releases afterwards.
    return yield* outcome;
  },
);

/** Acquire a recovered run and reload its cursor before starting its live scope. */
const resumeToolUse = Effect.fn('resumeToolUse')(function* (
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
) {
  const session = options.session;
  // The claim's lifetime is the whole resume, as one `acquireRelease`:
  // acquired before the cursor read so no concurrent owner mutates the run
  // between the read and the launch, released when this scope closes — after
  // the launch's own scope and its compensating finalizers, never before
  // them, and on every exit the old rollback/release pair covered.
  // A release finalizer cannot fail, and a failed claim release is no
  // defect either — a drain that lost queued facts is the caller's typed
  // error. The finalizer records it and the fold after the scope re-fails:
  // alone after a successful turn, aggregated behind the run's own failure
  // otherwise, the run's first — `Effect.onExit`-style combining would bury
  // it instead.
  let releaseFailure: Error | undefined;
  const outcome = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        // A recovered child's continuous driver holds the claim already; a
        // standalone resume takes it here.
        if (!options.turns) {
          yield* Effect.acquireRelease(
            acquireResumedRunOwnership(session, identity.runId),
            () =>
              session.releaseRunLease(identity.runId).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    releaseFailure = error;
                  }),
                ),
              ),
          );
        }
        const retrieved = yield* retrieveSessionResumeData(
          identity.runId,
          identity.agentConfig,
          session,
        ).pipe(
          Effect.flatMap((retrieved) =>
            retrieved?.type === 'toolUse'
              ? Effect.succeed(retrieved)
              : Effect.fail(new ResumeSessionUnavailableError(identity.runId)),
          ),
        );
        // The launched turn owns the run from here, including setup failures.
        return yield* resumeToolUseWithOwnedLease(retrieved, options);
      }),
    ),
  );
  if (Exit.isSuccess(outcome)) {
    if (releaseFailure !== undefined) return yield* Effect.fail(releaseFailure);
    return outcome.value;
  }
  // An interruption unwinds straight past the fold; nothing aggregates
  // behind it.
  if (releaseFailure === undefined || Cause.hasInterruptsOnly(outcome.cause))
    return yield* Effect.failCause(outcome.cause);
  return yield* Effect.fail(
    new AggregateError(
      [ensureError(Cause.squash(outcome.cause)), releaseFailure],
      `Run ${identity.runId} failed and its final artifacts could not be persisted`,
    ),
  );
});

/** Resume after the previous generation and its teardown have settled, on
 *  the `Runs` of `options.session`. */
export function resumeToolUseFromResumeData(
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
): Effect.Effect<AgentFlowResult, Error, ProcessServices> {
  const { runs } = options.session;
  // A recovered child's continuous driver already holds this run lane.
  // Standalone host roots acquire it here; neither path launches a second owner.
  const program = resumeToolUse(identity, options);
  return (
    options.turns ? program : runs.launchRun(identity.runId, program)
  ).pipe(Effect.provideService(Runs, runs));
}
