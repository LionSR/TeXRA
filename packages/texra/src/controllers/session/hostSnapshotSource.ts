/**
 * The `host` snapshot of one session:
 * what the shell renders but does not own. It rides on every frame that
 * follows a change and on every subscribe, so a surface never asks for a
 * catalog and never holds a stale one. Every producer is a read the host
 * already owns; nothing here is a fact about a run (`SessionView`) or a
 * choice of the user's (`Surface`). The model options, the file lists, the recent
 * commits and the onboarding funnel are host-neutral; the host injects its
 * workspace-root picker and which notices it shows (a VS Code window shows
 * the lost-credential banner and offers to start a project; the desktop
 * keeps the first in Settings).
 *
 * The source holds one `SubscriptionRef` of its inputs. Each producer reads
 * and then writes its own fields, so the last write of a field wins and no
 * producer waits on another; the snapshot is the inputs mapped, so a field
 * derived from several inputs (the funnel, a banner's visibility) is never
 * stored. The model options and the credential follow the app signals that
 * announce their changes, written by any writer in the process, so no host
 * or settings page pushes a reload; the approval policy is read live as
 * each snapshot is mapped.
 */
import {
  Effect,
  type FileSystem,
  Option,
  Predicate,
  type Path,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import {
  appSignalStream,
  subscribeAppSignal,
  workspaceEnvironmentLayer,
} from '@texra-ai/worldline/host';
import {
  Settings,
  logFailure,
  type AppSignals,
  type Secrets,
  type SettingsStores,
  AppState,
} from '@texra-ai/worldline/plugins';
import {
  APPROVAL_POLICY_SETTING,
  ensureError,
} from '@texra-ai/worldline/schemas';
import { isPathWithin, recentCommitLabels } from '@texra-ai/worldline/node';
import { apiKeyEntry } from '@texra-ai/llm';
import { GIT_COMMITS_TO_SHOW_SETTING } from '@texra/shared/settings/texraSettings';
import type {
  FileOptions,
  HostSnapshot,
  MissingTool,
  ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { workspaceFileOptions } from '@texra/controllers/session/workspaceFileOptions';
import {
  hasUsableSetupCredential,
  loadModelOptions,
} from '@texra/model/setupCredentialAccess';
import { missingDependencyTools } from '@latex/latexToolchain';
import {
  deriveOnboardingFunnelState,
  ONBOARDING_FLAG_KEYS,
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';

const CHANNEL = 'Host Snapshot';

type DismissibleBanner = Extract<
  HostCommand,
  { kind: 'dismissBanner' }
>['banner'];

interface HostSnapshotSourceOptions {
  project: ProjectDisplay;
  tools: HostSnapshot['tools'];
  /** The project folder the launcher's file lists and the recent commits
   *  are read from and whose `.env` the credential check reads; `undefined`
   *  for a session with no folder open, which is never a repository. */
  root: string | undefined;
  /**
   * The owning session's three setting slots: its workspace-scoped agent
   * list state, its configuration, and the process global state. The model
   * catalog's availability read resolves the routing switches and the two
   * "prefer my subscription" preferences against these, so a host with several
   * open projects in one process answers for the project this source belongs
   * to.
   */
  stores: SettingsStores;
  /** The launcher's root picker; empty where a session has exactly one. */
  workspaceRoots(): HostSnapshot['workspaceRoots'];
  /** The notices this host shows: the lost-credential banner, the tools
   *  this machine lacks, and the offer to start a project (a sample, an
   *  Overleaf clone, an arXiv download) while the folder has no LaTeX files. */
  shows: {
    readonly apiKeyBanner: boolean;
    readonly dependencyBanner: boolean;
    readonly gettingStarted: boolean;
  };
}

/** What the producers write; the snapshot is {@link snapshotOf} of it. */
interface Inputs {
  /** False until the first {@link HostSnapshotSource.refresh} has finished,
   *  so the shell never paints an empty model list. */
  readonly loaded: boolean;
  readonly modelOptions: HostSnapshot['modelOptions'];
  readonly workspaceRoots: HostSnapshot['workspaceRoots'];
  readonly fileOptions: FileOptions;
  readonly commits: { readonly commits: string[]; readonly isGitRepo: boolean };
  readonly missingTools: readonly MissingTool[];
  readonly recording: HostSnapshot['recording'];
  readonly service: HostSnapshot['banners']['service'];
  /** A dismissal lasts the session. */
  readonly dismissed: ReadonlySet<DismissibleBanner>;
  /** Whether a usable credential exists; undefined until a check answers. */
  readonly credential: boolean | undefined;
  /** The user's onboarding flags; undefined until a read answers, which is
   *  not "never skipped, no run yet". */
  readonly flags:
    | { readonly declined: boolean; readonly firstRunDone: boolean }
    | undefined;
}

export interface HostSnapshotSource {
  /** The snapshot as the inputs change, from the first refresh on. */
  readonly changes: Stream.Stream<HostSnapshot>;
  /** Whether a usable credential exists, as each check answers. */
  readonly credentialUsable: Stream.Stream<boolean>;
  /** Read every input again. */
  readonly refresh: Effect.Effect<
    void,
    never,
    | Secrets
    | SubscriptionAccounts
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner
  >;
  /** The project's files changed on disk outside TeXRA, or the surface
   *  asked for a relist. TeXRA's own writes (`workspaceFilesWritten`) are
   *  followed by the source itself. */
  readonly refreshFiles: Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  /** Each write TeXRA made inside the project, for a host view of the
   *  project's files beside the launcher (the desktop's file tree). */
  readonly filesWritten: Stream.Stream<void, never, AppSignals>;
  readonly refreshCommits: Effect.Effect<void, never, ChildProcessSpawner>;
  /** A tool may have been installed: the missing tools are checked again,
   *  with the credential. */
  readonly refreshHostBanners: Effect.Effect<
    void,
    never,
    ChildProcessSpawner | Secrets | SubscriptionAccounts
  >;
  /** The workspace folders changed. */
  readonly refreshWorkspaceRoots: Effect.Effect<void>;
  /** The one recorder per process started or stopped. */
  setRecording(recording: HostSnapshot['recording']): Effect.Effect<void>;
  /** The user dismissed a notice for the rest of this session. */
  dismissBanner(banner: DismissibleBanner): Effect.Effect<void>;
  /** Where the window's tasks run, when the user should be told: its
   *  service link holds no service (`ServiceLink.away`), or its folder's
   *  tasks run in this process; null otherwise. */
  setServiceBanner(
    banner: HostSnapshot['banners']['service'],
  ): Effect.Effect<void>;
}

/** A failed read keeps its fields' last values and says why at `warn`, so
 *  a single unavailable source never blanks the shell. */
const keepOnFailure =
  (what: string) =>
  <R>(load: Effect.Effect<void, Error, R>): Effect.Effect<void, never, R> =>
    load.pipe(
      Effect.catch(
        logFailure(CHANNEL, `The host snapshot could not read ${what}`),
      ),
    );

/**
 * The project's display record and the model options, assembled per session
 * for the caller's scope: the scope holds the followers of the onboarding
 * flags, the model options, the credential and the approval policy.
 */
export const openHostSnapshotSource = Effect.fn('openHostSnapshotSource')(
  function* (
    options: HostSnapshotSourceOptions,
  ): Effect.fn.Return<
    HostSnapshotSource,
    never,
    | Scope.Scope
    | AppState
    | AppSignals
    | Secrets
    | SubscriptionAccounts
    | FileSystem.FileSystem
    | Path.Path
  > {
    const { stores } = options;
    const appState = yield* AppState;
    const inputs = yield* SubscriptionRef.make<Inputs>({
      loaded: false,
      modelOptions: [],
      workspaceRoots: options.workspaceRoots(),
      fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
      commits: { commits: [], isGitRepo: false },
      missingTools: [],
      recording: null,
      service: null,
      dismissed: new Set(),
      credential: undefined,
      flags: undefined,
    });
    /** Write `patch` when it changes a field, so an unchanged write
     *  publishes nothing. */
    const write = (patch: Partial<Inputs>) =>
      SubscriptionRef.updateSome(inputs, (current) =>
        Object.entries(patch).some(
          // cast: `Object.entries` widens keys to string; `patch` is a
          // `Partial<Inputs>`, so each key is one of `Inputs`.
          ([key, value]) => current[key as keyof Inputs] !== value,
        )
          ? Option.some({ ...current, ...patch })
          : Option.none(),
      );

    /**
     * One producer: its read, then its write. Two reads of one producer in
     * flight (a burst of file-watcher events) run in the order they were
     * asked for, so the older read never lands last; different producers
     * never wait on each other.
     */
    const producer = Effect.fnUntraced(function* <R>(
      what: string,
      load: Effect.Effect<void, Error, R>,
    ) {
      const lane = yield* Semaphore.make(1);
      // The producer is the returned effect, run once per read.
      // @effect-diagnostics-next-line returnEffectInGen:off
      return keepOnFailure(what)(load).pipe(lane.withPermit);
    });

    // The project's `.env` over the process's: the keys a run of this
    // project would use, for its models as for its credential below. An
    // unreadable `.env` dies in its layer; here it fails the read, so the
    // producer keeps the field's last value and says why.
    const underProjectEnv = <A, E, R>(read: Effect.Effect<A, E, R>) =>
      read.pipe(
        Effect.provide(workspaceEnvironmentLayer(options.root)),
        Effect.catchDefect((defect) => Effect.fail(ensureError(defect))),
      );
    const loadModels = yield* producer(
      'the models',
      Effect.flatMap(loadModelOptions(stores), (modelOptions) =>
        SubscriptionRef.update(inputs, (s) => ({ ...s, modelOptions })),
      ).pipe(underProjectEnv),
    );
    const loadFiles = yield* producer(
      'the project files',
      Effect.flatMap(workspaceFileOptions(options.root), (fileOptions) =>
        write({ fileOptions }),
      ),
    );
    const loadCommits = yield* producer(
      'the recent commits',
      Effect.gen(function* () {
        if (options.root === undefined) return;
        const labels = yield* recentCommitLabels(
          options.root,
          yield* Settings.get(stores, GIT_COMMITS_TO_SHOW_SETTING),
        );
        yield* write({
          commits: { commits: [...(labels ?? [])], isGitRepo: labels !== null },
        });
      }),
    );
    const loadDependencies = yield* producer(
      'the missing tools',
      options.shows.dependencyBanner
        ? Effect.flatMap(missingDependencyTools(), (missingTools) =>
            write({ missingTools }),
          )
        : Effect.void,
    );
    const loadCredential = yield* producer(
      'the provider credentials',
      underProjectEnv(hasUsableSetupCredential(stores)).pipe(
        Effect.flatMap((credential) => write({ credential })),
      ),
    );
    const loadFlags = yield* producer(
      'the onboarding flags',
      Effect.flatMap(readOnboardingFlags(appState), (flags) =>
        write({ flags }),
      ),
    );

    const hostBanners = Effect.all([loadCredential, loadDependencies], {
      concurrency: 'unbounded',
      discard: true,
    });

    // The flags are user-scoped and may be written by another process.
    yield* appState.changes(ONBOARDING_FLAG_KEYS).pipe(
      Stream.runForEach(() => loadFlags),
      Effect.forkScoped,
    );
    /** Run `load` after each element of `signals`, a subscription the
     *  source's scope already holds (`subscribeAppSignal`), so no signal
     *  published after the source opens is missed. Signals that arrive
     *  during a load are answered by one more load, not one each. A defect
     *  is logged and the following goes on. */
    const follow = <R>(
      signals: Stream.Stream<unknown>,
      load: Effect.Effect<void, never, R>,
    ) =>
      signals.pipe(
        Stream.buffer({ capacity: 1, strategy: 'sliding' }),
        Stream.runForEach(() =>
          load.pipe(
            Effect.catchDefect(
              logFailure(CHANNEL, 'The host snapshot could not reload'),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    // Any secret written (`credentialChanged`) may change the credential;
    // only a provider's API key, or a model-access preference or
    // enabled-model write (`modelAccessChanged`), changes the models listed,
    // so an OAuth refresh or a GitHub token reloads no catalog. A sign-in
    // announces its token write, then its preference (`modelAccessChanged`).
    const providerKey = ({ key }: { readonly key: string }) =>
      (apiKeyEntry(key) ?? 'unknown') !== 'unknown';
    yield* follow(
      Stream.filter(
        yield* subscribeAppSignal('credentialChanged'),
        Predicate.not(providerKey),
      ),
      loadCredential,
    );
    yield* follow(
      Stream.merge(
        Stream.filter(
          yield* subscribeAppSignal('credentialChanged'),
          providerKey,
        ),
        yield* subscribeAppSignal('modelAccessChanged'),
      ),
      Effect.andThen(loadCredential, loadModels),
    );
    // A write TeXRA made inside the project (an accepted output or diff, a
    // service task's file) can add a file the launcher lists, on every host
    // alike; a host may also follow edits made outside TeXRA
    // (`refreshFiles`).
    const root = options.root;
    const writtenInProject = ({
      absolutePaths,
    }: {
      readonly absolutePaths: readonly string[];
    }) =>
      root !== undefined &&
      absolutePaths.some((written) => isPathWithin(root, written));
    yield* follow(
      Stream.filter(
        yield* subscribeAppSignal('workspaceFilesWritten'),
        writtenInProject,
      ),
      loadFiles,
    );
    // The approval policy is read live as each snapshot is mapped; a
    // settings view's write republishes the inputs so the change shows.
    yield* follow(
      yield* subscribeAppSignal('approvalPolicyChanged'),
      SubscriptionRef.update(inputs, (current) => ({ ...current })),
    );
    // Configuring a credential clears a previous "Skip for now", so a user
    // who later loses every credential sees the picker again.
    yield* SubscriptionRef.changes(inputs).pipe(
      Stream.map((s) => s.flags?.declined === true && s.credential === true),
      Stream.changes,
      Stream.filter(Boolean),
      Stream.runForEach(() =>
        setOnboardingDeclined(appState, false).pipe(
          Effect.catch(
            logFailure(CHANNEL, 'Clearing the onboarding skip failed'),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const snapshotOf = (s: Inputs): HostSnapshot => ({
      project: options.project,
      tools: options.tools,
      approvalPolicy: Settings.getConfig(
        stores.config,
        APPROVAL_POLICY_SETTING,
      ),
      modelOptions: s.modelOptions,
      workspaceRoots: s.workspaceRoots,
      fileOptions: {
        ...s.fileOptions,
        commit: ['HEAD', ...s.commits.commits],
      },
      isGitRepo: s.commits.isGitRepo,
      recording: s.recording,
      banners: {
        // A credential that worked stopped working: raised only once a task
        // has finished; before that the "Connect a model" card is the prompt.
        apiKey:
          options.shows.apiKeyBanner &&
          s.credential === false &&
          s.flags?.firstRunDone === true,
        dependency:
          s.missingTools.length > 0 && !s.dismissed.has('dependency')
            ? s.missingTools
            : null,
        gettingStarted:
          options.shows.gettingStarted &&
          s.fileOptions.baseFile.length === 0 &&
          !s.dismissed.has('gettingStarted'),
        service: s.service,
      },
      // An unanswered check or flag read is not "no credential" or "not
      // done": until both answer, the funnel stays out of the way.
      onboarding:
        s.credential === undefined || s.flags === undefined
          ? 'done'
          : deriveOnboardingFunnelState({
              hasCredential: s.credential,
              ...s.flags,
            }),
    });

    return {
      changes: SubscriptionRef.changes(inputs).pipe(
        Stream.filter((s) => s.loaded),
        Stream.map(snapshotOf),
      ),
      credentialUsable: SubscriptionRef.changes(inputs).pipe(
        Stream.map((s) => s.credential),
        Stream.filter((credential) => credential !== undefined),
        Stream.changes,
      ),
      refresh: Effect.all(
        [loadModels, loadFiles, loadCommits, hostBanners, loadFlags],
        { concurrency: 'unbounded', discard: true },
      ).pipe(Effect.andThen(write({ loaded: true }))),
      refreshFiles: loadFiles,
      filesWritten: appSignalStream('workspaceFilesWritten').pipe(
        Stream.filter(writtenInProject),
        Stream.as(undefined),
      ),
      refreshCommits: loadCommits,
      refreshHostBanners: hostBanners,
      refreshWorkspaceRoots: Effect.suspend(() =>
        write({ workspaceRoots: options.workspaceRoots() }),
      ),
      setRecording: (recording) => write({ recording }),
      dismissBanner: (banner) =>
        SubscriptionRef.updateSome(inputs, (s) =>
          s.dismissed.has(banner)
            ? Option.none()
            : Option.some({
                ...s,
                dismissed: new Set([...s.dismissed, banner]),
              }),
        ),
      setServiceBanner: (service) => write({ service }),
    };
  },
);
