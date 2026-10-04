/**
 * What a window drives a session through: the session this process holds,
 * or the one the background service holds for it (`texra serve`). Every
 * action a window takes on a run goes through here, so in service mode no
 * window writes the run history: the service is the one writer.
 *
 * The port is the window's half of the session API (launch, resume,
 * requests, frames, the view it reads run state from, the approval policy),
 * not a mirror of `SessionHandle`.
 */
import { Effect, type Stream, type SubscriptionRef } from 'effect';

import { resumeOnSession } from '@agent/followUp/ToolUseFollowUp';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { runAgent, type RunAgentRequest } from '@agent/runtime/runAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ToolEditPreview } from '@controllers/server/protocol';
import { launchOnRun } from '@controllers/mainView/backend/MainViewRunLaunchController';
import type { ProcessServices } from '@platform/processRuntime';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { RunId, TranscriptSubscription } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  Unavailable,
  type RequestError,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';

import { frameSubscription } from './SessionFramer';

/** The session a window works on, wherever its runs run. */
export interface SessionBackend {
  /** The session key every frame carries: the session's storage root. */
  readonly key: string;
  /** The session's state as this window reads run state from it. */
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
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
  /**
   * Start a fresh run. Answers the run's result when it ran where the caller
   * can open its output, null once the service admitted it.
   */
  readonly launch: (
    request: RunAgentRequest,
    options: SessionLaunchOptions,
  ) => Effect.Effect<RunEndResult | null, Error, ProcessServices>;
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
  /** Refuse a config whose category differs from its agent's. */
  readonly enforceCategory?: boolean;
}

/** The backend of a session this process holds. */
export function localSessionBackend(session: SessionHandle): SessionBackend {
  const key = session.roots.storage;
  return {
    key,
    view: session.view,
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
        enforceCategory: options.enforceCategory,
        continues: options.continues,
        onRunResolved: options.onRunResolved,
        suppressErrorNotification: options.suppressErrorNotification,
      }),
    request: (request) => session.requests.request(request),
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
