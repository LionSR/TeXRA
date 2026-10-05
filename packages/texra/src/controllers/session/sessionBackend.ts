/**
 * What a window drives a session through: the session this process holds,
 * or the one the background service holds for it (`texra serve`). Every
 * action a window takes on a run goes through here, so in service mode no
 * window writes the run history: the service is the one writer.
 *
 * The port is the window's half of the session API (launch, resume,
 * requests, frames, the view it reads run state from, a live run's model
 * switch, the approval policy),
 * not a mirror of `SessionHandle`.
 */
import { Effect, Option, Stream, SubscriptionRef } from 'effect';

import {
  Unavailable,
  type RequestError,
  type RequestRefusal,
} from '@texra-ai/harness';
import { resumeOnSession } from '@agent/followUp/ToolUseFollowUp';
import {
  buildTerminalRunEndResult,
  type RunEndResult,
} from '@agent/runtime/RunEndResult';
import { getRunRecords } from '@agent/storage/runRecords';
import type { RunControls } from '@agent/runtime/RunHandle';
import { runAgent, type RunAgentRequest } from '@agent/runtime/runAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ProcessServices } from '@platform/processRuntime';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  RUN_OUTCOME,
  type RunId,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import { isLiveRun, type SessionView } from '@shared/session/sessionView';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';
import { launchOnRun } from '@texra/controllers/mainView/backend/MainViewRunLaunchController';
import type { ToolEditPreview } from '@texra/controllers/server/protocol';
import type { Outcome, RuntimeRequest } from '@texra-ai/harness';

/** What a window asks of a live run's loop: its model switch. */
type RunModelControls = Pick<
  RunControls,
  'modelSwitchDisabledReason' | 'switchModel'
>;

/** The session a window works on, wherever its runs run. */
export interface SessionBackend {
  /** The session key every frame carries: the session's storage root. */
  readonly key: string;
  /** The session's state as this window reads run state from it. */
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  /** Each level of {@link view}, from the current one. */
  readonly viewChanges: Stream.Stream<SessionView>;
  /** The frames that answer one port's `Subscribe`, `host` merged in. */
  readonly frames: (
    port: string,
    host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>,
    subscribe: Subscribe,
  ) => Stream.Stream<EventsFrame>;
  /** One port's transcript set: the runs whose history its view folds.
   *  An empty set removes the port (it went away). */
  readonly transcripts: (
    port: string,
    set: readonly TranscriptSubscription[],
  ) => Effect.Effect<void>;
  /** One runtime request (stop, decide, follow-up, fork, …). */
  readonly request: (
    request: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** Start a fresh run, and settle with its result once it ends. */
  readonly launch: (
    request: RunAgentRequest,
    options: SessionLaunchOptions,
  ) => Effect.Effect<RunEndResult, Error, ProcessServices>;
  /**
   * Continue a settled run. Answers the run that resumed (the one asked
   * for, or the parent that owns it) and its result when it ended where the
   * caller can open its output; null when it waits for what blocks it.
   */
  readonly resume: (
    runId: RunId,
  ) => Effect.Effect<
    { readonly runId: RunId; readonly result: RunEndResult | null } | null,
    RequestRefusal
  >;
  /** A pending tool edit's original and proposed content, when another
   *  process runs the tool; null when this process staged it itself. */
  readonly preview: (
    requestId: string,
  ) => Effect.Effect<ToolEditPreview | null, Error>;
  /** What `runId`'s current activation ends with, once it has ended: what
   *  a resume waits on. */
  readonly ended: (runId: RunId) => Effect.Effect<RunEndResult>;
  /** A live run's model switch, while its loop runs; undefined otherwise. */
  readonly controls: (runId: RunId) => RunModelControls | undefined;
  /** The session's approval policy, from this window's settings. */
  readonly setApprovalPolicy: (
    policy: TexraApprovalPolicy,
  ) => Effect.Effect<void>;
}

/** How a window launches a run, whichever backend runs it. */
interface SessionLaunchOptions {
  /** Run on the configured helper model (the "fix LaTeX" actions). */
  readonly preferHelperModel?: boolean;
  /** Replaces a quota-exhausted retry with the user's own API key. */
  readonly ownApiKeyFallback?: boolean;
  /** An Auto-approve launch: the run starts with delegated work approved. */
  readonly approveDelegatedWork?: boolean;
  /** The run is registered (its id is final); before its body runs here. */
  readonly onRun?: (runId: RunId) => Effect.Effect<void, Error>;
  /** The run this launch resolved, for the window to select. */
  readonly onRunResolved?: (runId: RunId) => void;
  /** The window presents failures itself. */
  readonly suppressErrorNotification?: boolean;
  /** The chat's previous root: its approval bypasses carry over. */
  readonly continues?: RunId;
}

/**
 * What `runId` ends with in `session`, the process running it: once every
 * owner of the run has left, its `run.end` as the run's records hold it. A
 * run that ended with no `run.end` it could read (deleted, or its store
 * unreadable) ends with the outcome its view shows, without output.
 */
export function runEnded(
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<RunEndResult> {
  return Effect.gen(function* () {
    yield* session.runs.awaitDrained(runId);
    const head = yield* SubscriptionRef.changes(session.view).pipe(
      Stream.map((view) => view.runs.get(runId)),
      Stream.filter((run) => run === undefined || !isLiveRun(run)),
      Stream.runHead,
    );
    const run = Option.getOrUndefined(head);
    const end = yield* getRunRecords(session, runId)
      .readRunEnd()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Task ${runId} ended; its result was not read: ${error.message}`,
          ).pipe(Effect.as(null)),
        ),
      );
    if (end !== null)
      return { outcome: end.outcome, output: end.output, runId };
    return buildTerminalRunEndResult(
      run?.durableOutcome ?? RUN_OUTCOME.CANCELLED,
      runId,
    );
  });
}

/** The backend of a session this process holds. */
export function localSessionBackend(session: SessionHandle): SessionBackend {
  const key = session.roots.storage;
  return {
    key,
    view: session.view,
    viewChanges: session.viewChanges,
    frames: (port, host, subscribe) =>
      frameSubscription(
        {
          key,
          view: session.view,
          inputs: session.inputs,
          setTranscriptSubscriptions: session.subscriptions.set,
        },
        port,
        host,
        subscribe,
      ),
    transcripts: (port, set) => session.subscriptions.set(port, set),
    launch: (request, options) =>
      runAgent(request, {
        session,
        preferHelperModel: options.preferHelperModel ?? false,
        ownApiKeyFallback: options.ownApiKeyFallback,
        onRun: launchOnRun(session.approvals, options),
        continues: options.continues,
        onRunResolved: options.onRunResolved,
        suppressErrorNotification: options.suppressErrorNotification,
      }),
    request: (request) => session.requests.request(request),
    controls: (runId) => session.runs.getHandle(runId)?.controls,
    ended: (runId) => runEnded(session, runId),
    resume: (runId) =>
      Effect.flatMap(resumeOnSession(runId, session), (resumed) => {
        // A blocked resume is asked for, not refused: the task's own line
        // says what it waits for, and it continues once that is back.
        if ('failed' in resumed && resumed.failed === 'blocked')
          return Effect.succeed(null);
        if (!('started' in resumed) || !resumed.delivered)
          return Effect.fail(
            new Unavailable({
              runId,
              reason: 'This run could not be resumed.',
            }),
          );
        return Effect.succeed({ runId, result: resumed.result ?? null });
      }),
    // A tool this process runs stages its own preview (`presentToolEdit`).
    preview: () => Effect.succeed(null),
    setApprovalPolicy: (policy) =>
      Effect.sync(() => session.setApprovalPolicy(policy)),
  };
}
