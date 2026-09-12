/** Public Effect session and run capabilities for embedders. */
import { Context, type Effect, type Stream, type Scope } from 'effect';

import type { AgentEvent } from '@agent/trace';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  RunId,
  SessionCloseReport,
  TranscriptSubscription,
} from '@shared/schemas';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type {
  SessionView as RuntimeSessionView,
  RunView as RuntimeRunView,
  TranscriptView as RuntimeTranscriptView,
} from '@shared/session/sessionView';

import type { LaunchError, RunFailure } from './errors.js';

/**
 * A runtime value as the embedder may hold it: read-only all the way down,
 * every map, array, and record included. The value itself is not copied
 * (the fold publishes immutable levels); the type is what keeps a write
 * from reaching it.
 */
type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, ReadonlyDeep<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<ReadonlyDeep<V>>
      : T extends readonly (infer E)[]
        ? readonly ReadonlyDeep<E>[]
        : T extends object
          ? { readonly [P in keyof T]: ReadonlyDeep<T[P]> }
          : T;

/** One published level of the session's fold: an immutable value. */
export type SessionView = ReadonlyDeep<RuntimeSessionView>;
/** One stream of the {@link SessionView}. */
export type RunView = ReadonlyDeep<RuntimeRunView>;
/** A stream's transcript slice: what hosts paint. */
export type TranscriptView = ReadonlyDeep<RuntimeTranscriptView>;

/** What starting a run on a session takes. */
export interface StartInput {
  readonly agent: string;
  readonly instruction: string;
  readonly model?: string;
  readonly tools?: readonly ITool[];
}

/** One run of an agent, from the moment it exists in its session. */
export interface Run {
  /** The run's id, minted here and handed to the launcher, so it
   *  identifies the run before its first model call. */
  readonly runId: RunId;
  /**
   * The run's own outcome first: on failure the fold's fate never replaces
   * it; on success this waits for the level holding the durable outcome.
   */
  readonly result: Effect.Effect<AgentFlowResult, RunFailure>;
  /**
   * The session's levels sliced to this run: from the first level holding
   * its stream through the first holding its durable outcome. Typed error
   * `never`: a dead fold is a defect, as `SessionViewService.changes`
   * publishes it.
   */
  readonly view: Stream.Stream<SessionView>;
  /**
   * The run's trace, buffered from the moment the run enters the session so
   * that no launch event is lost to a reader that has yet to attach. Ends
   * when the run settles, fails with {@link RunFailure} when the run failed,
   * and drops what it holds when the run settles unread. Running it once is
   * the contract: ending the iteration detaches the trace while the run
   * continues. The pre-reader buffer is bounded: a run whose events pass
   * the bounded handover queue with nobody reading has no reader, so it
   * warns and detaches rather than retaining the whole trace.
   */
  readonly events: Stream.Stream<AgentEvent, RunFailure>;
  /** Before the runtime hands over the live handle this aborts the launch;
   *  after, it interrupts the run. */
  readonly interrupt: Effect.Effect<void>;
}

/** One session of the process's owner, as this package works on it. */
export interface Session {
  readonly roots: WorkspaceRoots;
  /**
   * Admission: succeeds when the run exists in the session, with its stream
   * published and its trace live. Interrupting the caller before admission
   * aborts the launch; interrupting it during the handoff that follows ends
   * the run too, so a caller that does not receive a {@link Run} has none
   * running.
   */
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<Run, LaunchError | RunFailure>;
  /** The one handler of every request a surface issues to this session:
   *  answered exactly once, an outcome or a request error. */
  readonly request: (
    request: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** The fold's levels, each an immutable value. */
  readonly view: { readonly changes: Stream.Stream<SessionView> };
  /**
   * This reader's transcript interest, held for the scope and cleared when
   * it closes. Its port is the reader's own, so it never disturbs a run's.
   */
  readonly subscribe: (
    interests: readonly TranscriptSubscription[],
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** The process's session owner: one session per workspace storage root. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session of these roots, or the runtime's, through the process's
     *  one owner. */
    readonly open: (roots?: WorkspaceRoots) => Effect.Effect<Session>;
    /**
     * Refuse new runs, settle the ones it owns inside `signal`'s budget or
     * the runtime's shutdown-phase budget, flush, release.
     */
    readonly close: (
      roots?: WorkspaceRoots,
      signal?: AbortSignal,
    ) => Effect.Effect<SessionCloseReport>;
    readonly list: Effect.Effect<readonly Session[]>;
  }
>()('@texra-ai/agent/Sessions') {}
