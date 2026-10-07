/**
 * Public Effect session and run capabilities for embedders: `Sessions` is a
 * projection of the process's `SessionOwner`, and `Sessions.layer` composes
 * that process with the same `processLayer` every TeXRA host runs on.
 */
import { Context, Effect, Layer, type Stream, type Scope } from 'effect';

import type { AgentEvent } from '@agent/trace';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { SessionOwner } from '@agent/runtime/SessionOwner';
import { processLayer } from '@controllers/session/sessionLayer';
import {
  AppState,
  AgentDirectories,
  type AgentDirectoriesPort,
  type ToolMissingHandler,
} from '@platform/interfaces';
import type { LanguageModelPort } from '@platform/languageModel';
import type { ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  InlinePersona,
  RequestDecision,
  RunId,
  SessionCloseReport,
  TranscriptSubscription,
} from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import type { StateSettingEntry } from '@shared/state/stateSettings';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type {
  SessionView as RuntimeSessionView,
  RunView as RuntimeRunView,
  TranscriptView as RuntimeTranscriptView,
} from '@shared/session/sessionView';
import type { Plugin } from '@tools/plugins';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { toolTable } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  PluginsRefused,
  type LaunchError,
  type ResumeRefused,
  type SessionOptionsConflict,
  type ToolsRefused,
  type RunFailure,
} from './errors.js';
import { makeSessions } from './sessionPrograms.js';

/**
 * The process services the package composes, together with the workspace
 * roots the package's runs work in. `nodePlatform()` builds all of them; an
 * embedder supplying its own names its workspace roots beside them.
 */
export interface AgentPlatform {
  /** The agent directories this process's `AgentDirectories` service serves. */
  readonly agentDirectories: AgentDirectoriesPort;
  /** Surfaces a tool-missing error to the embedder, served as
   *  `ToolMissingReporter`; absent, a missing-tool probe answers without
   *  surfacing. */
  readonly toolMissingHandler?: ToolMissingHandler;
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
  /** The bridge its `LanguageModel` service serves; an embedder with no
   *  editor passes `UNAVAILABLE_LANGUAGE_MODEL_PORT`, as `nodePlatform()`. */
  readonly languageModel: LanguageModelPort;
  /** The MCP config file (`.mcp.json` shape) the process's tool registry
   *  reads; `nodePlatform()` names the one under its `storageDir`. */
  readonly mcpConfigPath: string;
}

/** What an embedder composes the process from: its platform, its
 *  plugins (the harness's built-ins among them), and the setting rows its
 *  plugins read, installed beside the harness's. */
export interface Composition {
  readonly platform: AgentPlatform;
  readonly plugins: readonly Plugin[];
  readonly settings?: readonly StateSettingEntry[];
}

/**
 * A runtime value as the embedder may hold it: read-only all the way down,
 * every map, array, and record included. The value itself is not copied
 * (the fold publishes immutable levels); the type is what keeps a write
 * from reaching it. A primitive stays itself, so a branded id (a `RunId`)
 * is still that id.
 */
type ReadonlyDeep<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never[]) => unknown)
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
/** A request a run waits on a person for, as {@link SessionView} lists it:
 *  which run asks, the request's id, and its payload (`payload.kind` is
 *  what is asked: a command, an edit, a plan, a retry, a question). */
export type PendingRequest = SessionView['requests'][number];

/**
 * The embedder's answer to each request a run of the session waits on: an
 * approval, a denial with its reason, or for a retry, `retry` or `cancel`.
 * The session records it as the request's `request.decided`, through the
 * same `request.decide` a {@link Session.request} sends. A handler that
 * fails, throws, or has not answered within ten minutes is a denial, with
 * the cause logged.
 */
export type ApprovalHandler = (
  request: PendingRequest,
) => Effect.Effect<RequestDecision>;

/** How {@link Sessions} opens a root's session. A later open of the same
 *  root gets the session already there, and must ask for the same options:
 *  one that differs fails with {@link SessionOptionsConflict}. */
export interface OpenOptions {
  /** Keep the session's history in the root's SQLite store (under
   *  `roots.storage`, the store every TeXRA host keeps), so a later process
   *  reopens it and resumes its runs. Absent, the store is in memory and
   *  ends with the session. */
  readonly persistent?: boolean;
  /** Answer the runs' requests. Absent, nobody answers: the session's
   *  policy denies every request and offers no approval-gated tool. */
  readonly approve?: ApprovalHandler;
}

/** What starting a run on a session takes. */
export interface StartInput {
  /** The agent: a name the agent directories list, or a persona written
   *  inline in the agent file format (`InlinePersonaSchema`), which the run
   *  records so a resume needs no file. */
  readonly agent: string | InlinePersona;
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
  readonly result: Effect.Effect<RunEndResult, RunFailure>;
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
  /**
   * Continue a persisted run of this session through the one resume path
   * every host takes, from its committed history: the same handle and the
   * same admission as {@link start}, and the same custom `tools`, which a
   * persisted run needs again to continue a call to one. A resume of a run
   * already resuming here joins it, with the same handle. A run nothing can
   * continue fails with {@link ResumeRefused}.
   */
  readonly resume: (
    runId: RunId,
    input?: Pick<StartInput, 'tools'>,
  ) => Effect.Effect<Run, ResumeRefused | ToolsRefused | RunFailure>;
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
     *  one owner; `options` decide its store and who answers its runs. */
    readonly open: (
      roots?: WorkspaceRoots,
      options?: OpenOptions,
    ) => Effect.Effect<Session, SessionOpenError | SessionOptionsConflict>;
    /**
     * Refuse new runs, settle the ones it owns inside the runtime's
     * shutdown-phase budget, flush, release.
     */
    readonly close: (
      roots?: WorkspaceRoots,
    ) => Effect.Effect<SessionCloseReport>;
    readonly list: Effect.Effect<readonly Session[]>;
  }
>()('@texra-ai/harness/Sessions') {
  /**
   * The Effect embedder's entry: compose the process from its platform and
   * its plugins (`harnessBuiltins.all` from `@texra-ai/harness/plugins`, or a
   * list of the embedder's own beside them), and serve its session owner for
   * this layer's lifetime; the layer's release closes every session still
   * open. A plugin list the harness cannot compose (an id that is not
   * lowercase letters, digits and dashes, an id or tool name listed twice)
   * fails with {@link PluginsRefused}, before anything is built.
   *
   * Build it once per process, as any Effect layer is memoized: two live
   * builds over one storage root are two writers of that root's sessions.
   */
  static layer({
    platform,
    plugins,
    settings = [],
  }: Composition): Layer.Layer<Sessions, PluginsRefused> {
    // A thunk: constructing the process layer installs the settings
    // catalog, which only a composition that passed the check may do.
    const sessions = (): Layer.Layer<Sessions> =>
      Layer.effect(
        Sessions,
        Effect.gen(function* () {
          return yield* makeSessions(
            platform.roots,
            yield* SessionOwner,
            yield* Effect.context<ProcessServices>(),
            yield* Effect.scope,
          );
        }),
      ).pipe(
        Layer.provide(
          processLayer({
            globalStorage: platform.roots.globalStorage,
            plugins,
            settings,
            mcpConfigPath: platform.mcpConfigPath,
            secrets: platform.secrets,
            appState: AppState.layer(platform.roots.globalState),
            languageModel: platform.languageModel,
            agentDirectories: AgentDirectories.layer(platform.agentDirectories),
            toolMissingReporter: platform.toolMissingHandler,
            // An embedder's console has no live level filter of its own, so the
            // package speaks at the informational level rather than flooding it.
            minimumLogLevel: 'Info',
          }),
        ),
      );
    // The list is checked before anything is composed, so a refusal names
    // the plugin rather than failing the first session open, and leaves the
    // process untouched. Then the first-install tool switches are seeded, as
    // every host's bootstrap seeds them, before the process's catalog first
    // reads them: the opt-in plugins stay off until the embedder switches
    // them on. A store that cannot be read or written is a platform defect.
    return Layer.unwrap(
      Effect.try({
        try: () => toolTable(plugins),
        catch: (thrown) =>
          new PluginsRefused({ message: toErrorMessage(thrown) }),
      }).pipe(
        Effect.tap(() =>
          seedDisabledToolDefaults(platform.roots.globalState, plugins).pipe(
            Effect.orDie,
          ),
        ),
        Effect.map(sessions),
      ),
    );
  }
}
