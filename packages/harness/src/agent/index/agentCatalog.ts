/**
 * The process's agent catalog: every agent the custom directory, the
 * bundled directories and the loaded plugins define, scanned into one
 * published list, and the reads, launch resolution and custom copies over it.
 * `processLayer` builds it once and a follower loads it and keeps it
 * current; every host reads it through this service.
 */
import {
  Clock,
  Context,
  Effect,
  Layer,
  type PlatformError,
  Schema,
} from 'effect';

import { LaunchRefused } from '@common/errors/agentErrors';
import { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentDirectories,
  type AgentDirectoriesFailed,
} from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { StateReadFailed } from '@shared/config/settings';
import type {
  AgentDelegationScope,
  AgentScanIssue,
  AgentSource,
} from '@shared/schemas';
import {
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

import { scanDirectory } from './agentYamlScanner';
import {
  agentSourceRoots,
  customizeCopy,
  type AgentCustomization,
  type AgentCustomizeRefused,
} from './AgentDirectoryService';
import { scanPluginAgents } from './pluginAgents';
import type { AgentCatalogServices, AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';

/** Resolving an agent directory failed (I/O or a rejected configured path). */
export class AgentCatalogLoadError extends Schema.TaggedError<AgentCatalogLoadError>()(
  'AgentCatalogLoadError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * The two state slots a workspace's agent list resolves against: the
 * repository's selection and the cross-workspace defaults. Every read is
 * answered for the workspace whose slots the caller hands over, so a process
 * holding several sessions never answers one paper's question with another's
 * agent list.
 */
export type WorkspaceAgentsStores = Pick<
  WorkspaceRoots,
  'repoState' | 'globalState'
>;

/**
 * One workspace's agents over the catalog: its selection, the agents it
 * shows (`visible`), and the agent a launch from it runs.
 */
export interface WorkspaceAgents extends WorkspaceAgentsController<AgentEntry> {
  /**
   * The agent a launch runs, over a settled catalog: the entry an explicit
   * `source` pins, else a visible one, else any. A miss reloads once, then
   * refuses the launch with what the load said.
   */
  readonly forLaunch: (
    identifier: string,
    source?: AgentSource | null,
  ) => Effect.Effect<
    AgentEntry,
    LaunchRefused | AgentCatalogLoadError | StateReadFailed
  >;
}

/** What the process's agent catalog serves (see {@link AgentCatalog}). */
export interface AgentCatalogShape {
  /** Every agent, one per name: a custom agent over a bundled one over a
   *  plugin's. */
  readonly list: () => readonly AgentEntry[];
  /** An agent by identifier, visibility ignored: a bare name takes the
   *  highest-priority source, a `source:name` key its exact entry, even one
   *  a higher-priority source shadows. */
  readonly get: (identifier: string) => AgentEntry | undefined;
  /** Custom-directory files the last load skipped, with the reason. */
  readonly scanIssues: () => readonly AgentScanIssue[];
  /** The bundled agent a custom copy was made from, when the bundled file
   *  changed since the copy was taken (it records `basedOn`). */
  readonly newerBuiltIn: (
    entry: Pick<AgentEntry, 'name' | 'source' | 'basedOn'>,
  ) => AgentEntry | undefined;
  /**
   * Rescan every source, after every older load has settled, and publish
   * the catalog rebuilt from empty. The last published catalog keeps
   * serving until then, including when the rescan fails.
   */
  readonly refresh: Effect.Effect<
    void,
    AgentCatalogLoadError | StateReadFailed
  >;
  /** A source changed and its reload waits out a debounce: the next
   *  `WorkspaceAgents.forLaunch` loads it first, so an agent saved a moment ago launches as
   *  saved. */
  readonly invalidate: Effect.Effect<void>;
  /**
   * A delegation scope's pinned agents, deduplicated by key: the list a
   * scoped delegating agent is told and its calls resolve against, in place
   * of its workspace's visible agents. Reads no store.
   */
  readonly pinned: (scope: AgentDelegationScope) => AgentEntry[];
  /** One workspace's agents over this catalog, its stores captured. */
  readonly workspaceAgents: (stores: WorkspaceAgentsStores) => WorkspaceAgents;
  /** Change a custom copy of `entry` (see {@link AgentCustomization}):
   *  the copy's path, and the files the agent binds that were already
   *  beside it and kept although they differ from the bundled ones. */
  readonly customize: (
    entry: AgentEntry,
    change: AgentCustomization,
  ) => Effect.Effect<
    { readonly path: string; readonly keptDiffering: readonly string[] },
    | AgentCustomizeRefused
    | AgentDirectoriesFailed
    | StateReadFailed
    | PlatformError.PlatformError
  >;
}

/**
 * Source priority for lookups, highest first. Every source is listed: an
 * absent one scores `-1` in `deduplicateByName`'s `indexOf`, ranking first by
 * accident.
 */
const LOOKUP_PRIORITY: AgentSource[] = ['custom', 'builtIn', 'plugin'];

/** Keep the highest-priority source of each name. */
function deduplicateByName(entries: Iterable<AgentEntry>): AgentEntry[] {
  const byName = new Map<string, AgentEntry>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (
      !existing ||
      LOOKUP_PRIORITY.indexOf(entry.source) <
        LOOKUP_PRIORITY.indexOf(existing.source)
    )
      byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

/**
 * Match an identifier against a candidate set: a source-qualified identifier
 * names one entry, so only its exact key counts; a bare one matches by name.
 * The single identity-matching rule every resolver goes through.
 */
export function findAgentByIdentifier(
  entries: readonly AgentEntry[],
  identifier: string,
): AgentEntry | undefined {
  return entries.find((entry) => agentMatchesIdentifier(entry, identifier));
}

/** What a load published, and whether a change waits to be loaded. */
interface CatalogState {
  entries: ReadonlyMap<string, AgentEntry>;
  customScanIssues: readonly AgentScanIssue[];
  /** Every agent file the load skipped, plugin files too: a miss names them. */
  skippedFiles: readonly AgentScanIssue[];
  /** Why the last load failed; absent once one publishes. */
  loadFailure: string | undefined;
  /** A source changed and its reload has not begun; cleared as a scan starts. */
  changePending: boolean;
  readonly teamMembers: AgentDirectories['Service']['teamMembers'];
}

/** Scan every agent source and publish the result into `state`. */
const scanInto = Effect.fn('agentCatalog.scanInto')(function* (
  state: CatalogState,
) {
  state.changePending = false;
  const startTime = yield* Clock.currentTimeMillis;
  const dirs = yield* AgentDirectories;
  const [customRoots, builtInRoots] = yield* Effect.all(
    [agentSourceRoots(dirs, 'custom'), agentSourceRoots(dirs, 'builtIn')],
    { concurrency: 'unbounded' },
  ).pipe(
    // The port names its own failure; the load is what the caller asked
    // for, so it carries the reason and the cause up.
    Effect.catchTag('AgentDirectoriesFailed', (failure) =>
      Effect.fail(
        new AgentCatalogLoadError({
          message: failure.message,
          cause: failure.cause,
        }),
      ),
    ),
  );
  const [custom, builtIn, plugin] = yield* Effect.all(
    [
      scanDirectory(customRoots, 'custom'),
      scanDirectory(builtInRoots, 'builtIn'),
      scanPluginAgents,
    ],
    { concurrency: 'unbounded' },
  );
  state.entries = new Map(
    [...custom.entries, ...builtIn.entries, ...plugin.entries].map(
      (entry) => [agentKeyOf(entry), entry] as const,
    ),
  );
  // Only custom-agent scan issues are a product surface.
  state.customScanIssues = Object.freeze(custom.issues);
  state.skippedFiles = Object.freeze(
    [custom, builtIn, plugin].flatMap((scan) => scan.issues),
  );
  yield* Effect.logInfo(
    `Loaded ${state.entries.size} agents in ${(yield* Clock.currentTimeMillis) - startTime}ms`,
  ).pipe(withLogChannel(CHANNEL));
});

/** Why a launch found nothing: the load's failure and the agent files it
 *  skipped. */
const missMessage = (state: CatalogState, identifier: string): string =>
  `Could not find agent: ${identifier}` +
  (state.loadFailure === undefined
    ? ''
    : `. The agent catalog did not load: ${state.loadFailure}`) +
  (state.skippedFiles.length === 0
    ? ''
    : `. Agent files that failed to load:${state.skippedFiles
        .map((issue) => `\n  ${issue.path}: ${issue.message}`)
        .join('')}`);

/** The reads over what a load published. */
function catalogReads(state: CatalogState) {
  const list = () => deduplicateByName(state.entries.values());
  const get = (identifier: string) =>
    identifier === agentName(identifier)
      ? findAgentByIdentifier(list(), identifier)
      : state.entries.get(identifier);
  const newerBuiltIn = (
    entry: Pick<AgentEntry, 'name' | 'source' | 'basedOn'>,
  ) => {
    if (entry.source !== 'custom' || entry.basedOn == null) return undefined;
    const builtIn = state.entries.get(agentKey('builtIn', entry.name));
    return builtIn && builtIn.digest !== entry.basedOn ? builtIn : undefined;
  };
  // Deduplicated by key: two identifiers of one entry give it once.
  const pinned = (scope: AgentDelegationScope) => [
    ...new Map(
      scope.flatMap((identifier) => {
        const entry = get(identifier);
        return entry ? [[agentKeyOf(entry), entry] as const] : [];
      }),
    ).values(),
  ];
  return { list, get, newerBuiltIn, pinned };
}

/** The process's agent catalog (see {@link AgentCatalogShape}). */
export class AgentCatalog extends Context.Service<
  AgentCatalog,
  AgentCatalogShape
>()('@texra-ai/harness/AgentCatalog') {
  /** An empty catalog over the process's agent directories; the follower
   *  loads it. */
  static readonly layer: Layer.Layer<
    AgentCatalog,
    never,
    AgentCatalogServices
  > = Layer.effect(
    AgentCatalog,
    Effect.gen(function* () {
      const services = yield* Effect.context<AgentCatalogServices>();
      const state: CatalogState = {
        entries: new Map(),
        customScanIssues: Object.freeze([]),
        skippedFiles: Object.freeze([]),
        loadFailure: undefined,
        changePending: false,
        teamMembers: Context.get(services, AgentDirectories).teamMembers,
      };
      // Every load enters one lane: a fiber that arrives while a load runs
      // waits for it, and a failed scan fails only its own caller.
      const onLoadLane = withPerKeyLane(
        new Map<string, PerKeyLane>(),
        'agentCatalogLoad',
      );
      const refresh = onLoadLane(
        scanInto(state).pipe(
          Effect.provide(services),
          Effect.tap(() =>
            Effect.sync(() => {
              state.loadFailure = undefined;
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              state.loadFailure = toErrorMessage(error);
            }),
          ),
        ),
      );
      const settled = Effect.suspend(() =>
        state.changePending ? refresh : onLoadLane(Effect.void),
      );
      const reads = catalogReads(state);
      const { list, get, newerBuiltIn } = reads;

      const workspaceAgents = ({
        repoState,
        globalState,
      }: WorkspaceAgentsStores): WorkspaceAgents => {
        const selection = new WorkspaceAgentsController<AgentEntry>({
          repoState,
          globalState,
          teamMembers: state.teamMembers,
          getAgents: list,
          resolveAgent: get,
        });
        // Each tier runs only when the one before has no match, so the exact
        // agent validation chose launches even if visibility changed since.
        const resolve = (
          identifier: string,
          source: AgentSource | null | undefined,
        ): Effect.Effect<AgentEntry | undefined, StateReadFailed> => {
          // A pinned source needs no selection read, so a failing store
          // cannot reject an entry the catalog holds.
          const pinned = source
            ? state.entries.get(agentKey(source, agentName(identifier)))
            : undefined;
          if (pinned) return Effect.succeed(pinned);
          return Effect.map(
            selection.visible(),
            (visibleAgents) =>
              findAgentByIdentifier(visibleAgents, identifier) ??
              get(identifier),
          );
        };
        const forLaunch = Effect.fn('forLaunch')(function* (
          identifier: string,
          source?: AgentSource | null,
        ) {
          const entry =
            (yield* Effect.andThen(settled, () =>
              resolve(identifier, source),
            )) ??
            (yield* Effect.andThen(refresh, () => resolve(identifier, source)));
          if (entry) return entry;
          return yield* new LaunchRefused({
            message: missMessage(state, identifier),
            notice: {
              event: 'agentNotFound',
              payload: { agentName: identifier },
            },
          });
        });
        return Object.assign(selection, { forLaunch });
      };

      const customize = (entry: AgentEntry, change: AgentCustomization) =>
        customizeCopy(entry, change, newerBuiltIn(entry)).pipe(
          Effect.provide(services),
        );

      return {
        list,
        get,
        scanIssues: () => state.customScanIssues,
        newerBuiltIn,
        refresh,
        invalidate: Effect.sync(() => {
          state.changePending = true;
        }),
        pinned: reads.pinned,
        workspaceAgents,
        customize,
      };
    }),
  );
}
