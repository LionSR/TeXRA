/**
 * The tool plugin manifest — the one list every tool belongs to: a stable id
 * plus dashboard copy, the opt-in toggle, the availability probe and the
 * install/auth actions. Implementations live in `@tools/registry`, which maps
 * each plugin id to its tool objects and fails the build when those names
 * differ from `toolNames` here; keeping implementations out keeps this
 * module's closure (and its readers') small. The entries themselves are
 * `MANIFEST` in `@tools/pluginManifest`; this module declares their shape,
 * checks them and is what every consumer reads.
 *
 * Derived from this list: the Tools dashboard (in list order) and each
 * card's inline settings rows, the agent creator's tool groups, availability
 * probes, the first-install toggle seed, switched-off plugins, a run's
 * injected tools (`@agent/runtime/agentToolResolution`), install/auth actions, `texra tools`
 * guides, and the bundled skills and agents the bootstrap installs, which a
 * switched-off plugin withholds with its tools.
 *
 * Rules: an id is persisted (the disabled-tools key), so it never changes and
 * is never reused; every tool belongs to exactly one plugin (checked below
 * and in the registry). No hooks, task kinds or second event channels: a
 * plugin holds state only in its process or session layer and writes rows
 * only of its own kinds, through the one publisher. A plugin is data,
 * re-registered by code at every startup.
 */

// Third-party imports
import { Effect, Result } from 'effect';
import { z } from 'zod';

// Local imports
import { StateReadFailed, type StateStore } from '@platform/interfaces';
import type { ToolCategory } from '@shared/settingsView/settingsViewMessages';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingHost } from '@shared/state/stateSettings';
import type { ToolAvailabilityChecks } from '@tools/toolProbes';
import { MANIFEST } from '@tools/pluginManifest';

/** One tool plugin. */
export interface ToolPlugin {
  /** Stable, persisted identifier (the dashboard item id and toggle key). */
  readonly id: string;
  /** The registered tools this plugin provides; `@tools/registry` checks
   *  them. Empty for a plugin whose contribution is not a tool. */
  readonly toolNames: readonly string[];
  /**
   * Present when the plugin has an external dependency: it is probed, its
   * tools are withheld while the dependency is missing, and the dashboard
   * shows its status and install actions. Without it the plugin is built in
   * and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  /** Checked for availability but listed on no Tools dashboard, and offered
   *  as no agent-creator tool group. */
  readonly hidden?: boolean;
  /** Product hosts whose Tools dashboard does not list the plugin. */
  readonly unavailableHosts?: readonly SettingHost[];
  /** Lowercase substrings of a new agent's description that make the agent
   *  creator preselect this plugin's tool group. */
  readonly keywords?: readonly string[];
  /** Settings rows the plugin's dashboard card renders inline, in order:
   *  each a settings-view catalog key and the row's short label (the card
   *  already names the plugin, so 'Model' rather than 'Claude Code model'). */
  readonly settings?: readonly (readonly [key: string, label: string])[];
  /** Tools of this plugin offered to every tool-use agent, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting key, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; workflow
   *  runs get none. */
  readonly injectedWhen?: Readonly<Record<string, string | true>>;
  /** Opt-in: the dashboard shows an enable/disable toggle, a fresh install
   *  seeds the plugin disabled (unless `onByDefault`), and while disabled its
   *  tools are withheld from every agent. */
  readonly toggleable?: boolean;
  /** A toggleable plugin a fresh install seeds on rather than off. */
  readonly onByDefault?: true;
  /** Decides what a parked run does next: a continuation in
   *  `PLUGIN_CONTINUATIONS` (`@tools/registry`), which a run's step pins
   *  while the plugin is switched on. */
  readonly continuation?: true;
  /** Adds a section to each request's system text: a function in
   *  `PLUGIN_PROMPT_SECTIONS` (`@tools/registry`), which a run's step pins
   *  while the plugin is switched on. */
  readonly promptSection?: true;
  /** Owns process-lifetime services: an entry in `PLUGIN_PROCESS_LAYERS`
   *  (`@tools/registry`), up while the plugin is switched on or a step pins
   *  it (`@tools/liveTools`). */
  readonly processLayer?: true;
  /** Its process-lifetime services come from the host that runs it, not
   *  from core: the host passes the layer to `installProcessRuntime`
   *  (`pluginLayers`), and it follows the same lifetime. */
  readonly hostLayer?: true;
  /** Owns session-lifetime services: an entry in `PLUGIN_SESSION_LAYERS`,
   *  one per open session, up while the plugin is switched on or a step of
   *  that session pins it. */
  readonly sessionLayer?: true;
  /** Writes rows of its own kinds: an arm in `PLUGIN_EVENT_ARMS`
   *  (`@tools/pluginArms`). They decode while the plugin is off; a build
   *  without the plugin keeps them unread. */
  readonly rows?: true;
  /** Ships skills / `builtInToolUse` agents in `resources/plugins/<id>/`. */
  readonly skills?: true;
  readonly agents?: true;
  /** Install and sign-in copy and actions for the dashboard and
   *  `texra tools`; only a probed plugin (one with `availability`) has any. */
  readonly setup?: ToolPluginSetup;
}

/** How a user gets a probed plugin's dependency installed and signed in. */
export interface ToolPluginSetup {
  readonly installGuide?: string;
  readonly installUrl?: string;
  /** VS Code extension ID — when present, the dashboard offers a direct "Install" button. */
  readonly installExtensionId?: string;
  /** Shell command the dashboard can run in an integrated terminal to install the tool. */
  readonly installCommand?: string;
  /** Shell command the dashboard can run to sign the user in (e.g. `codex login`). */
  readonly authCommand?: string;
  readonly configNotes?: string;
  /** Short auth/billing note shown as a badge (e.g. "Uses ChatGPT subscription"). */
  readonly authNote?: string;
}

/**
 * Every tool plugin, in dashboard order. The literal `MANIFEST` type feeds the
 * compile-time checks below and the registry's; consumers read this view.
 */
export const TOOL_PLUGINS: readonly ToolPlugin[] = MANIFEST;

export type ToolPluginEntry = (typeof MANIFEST)[number];

/** Every plugin id in the manifest. */
export type ToolPluginId = ToolPluginEntry['id'];

/** The tool names one plugin (or a union of plugins) declares. */
export type PluginToolName<Id extends ToolPluginId> = Extract<
  ToolPluginEntry,
  { readonly id: Id }
>['toolNames'][number];

/** The first id that repeats in a plugin tuple, or `never`. */
type DuplicateId<
  Plugins extends readonly { readonly id: string }[],
  Seen extends string = never,
> = Plugins extends readonly [
  infer Head extends { readonly id: string },
  ...infer Rest extends readonly { readonly id: string }[],
]
  ? Head['id'] extends Seen
    ? Head['id']
    : DuplicateId<Rest, Seen | Head['id']>
  : never;

type AssertNever<T extends never> = T;
/** Plugin ids are unique. */
type _PluginIdsAreUnique = AssertNever<DuplicateId<typeof MANIFEST>>;

/**
 * A tool name belongs to one plugin. On a clash the error names each plugin
 * id whose tools another plugin also declares.
 */
type AssertNoSharedToolNames<T extends Record<ToolPluginId, never>> = T;
type _ToolNamesAreUniqueAcrossPlugins = AssertNoSharedToolNames<{
  [Id in ToolPluginId]: PluginToolName<Id> &
    PluginToolName<Exclude<ToolPluginId, Id>>;
}>;

/**
 * A toggleable plugin is probed (`ALWAYS_AVAILABLE` when it needs nothing
 * installed), so switching it off withholds its tools; the error names the
 * toggleable plugin ids with no `availability`.
 */
type _ToggleablePluginsAreProbed = AssertNever<
  Exclude<
    Extract<ToolPluginEntry, { readonly toggleable: true }>['id'],
    Extract<ToolPluginEntry, { readonly availability: object }>['id']
  >
>;

/**
 * Setup copy is shown only for a probed plugin (the dashboard lists and
 * `texra tools` reads only those), so a plugin with `setup` declares
 * `availability`; the error names the plugin ids that do not.
 */
type _SetupPluginsAreProbed = AssertNever<
  Exclude<
    Extract<ToolPluginEntry, { readonly setup: object }>['id'],
    Extract<ToolPluginEntry, { readonly availability: object }>['id']
  >
>;

/** Look up a plugin by id. */
export function findToolPlugin(id: string): ToolPlugin | undefined {
  return TOOL_PLUGINS.find((plugin) => plugin.id === id);
}

/** The plugins the user's switches hold off: only a probed plugin has a
 *  switch, so a stored id of any other plugin switches nothing. */
export function switchedOffPlugins(
  disabled: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    [...disabled].filter((id) => findToolPlugin(id)?.availability != null),
  );
}

const DisabledToolIdsSchema = z.array(z.string());

/**
 * The switch record as stored, checked: the ids the user holds off, or
 * `undefined` while nothing (neither the first-install seed nor the user)
 * has written it. A present value that is not a list of ids is corruption and
 * fails as the read, rather than reading as "nothing off", which would switch
 * every opt-in plugin on.
 */
export function storedDisabledTools(
  stored: unknown,
): Result.Result<ReadonlySet<string> | undefined, StateReadFailed> {
  if (stored === undefined) return Result.succeed(undefined);
  const parsed = DisabledToolIdsSchema.safeParse(stored);
  return parsed.success
    ? Result.succeed(new Set(parsed.data))
    : Result.fail(
        new StateReadFailed({
          key: GlobalStateKey.DISABLED_TOOLS,
          message: `The tool switch record (${GlobalStateKey.DISABLED_TOOLS}) is unreadable: ${z.prettifyError(parsed.error)}`,
          cause: parsed.error,
        }),
      );
}

/** The plugin ids the user switched off in `store`'s record; none while it
 *  is absent. */
export function readDisabledTools(store: StateStore) {
  return store.get<unknown>(GlobalStateKey.DISABLED_TOOLS).pipe(
    Effect.flatMap((stored) => Effect.fromResult(storedDisabledTools(stored))),
    Effect.map((ids): ReadonlySet<string> => ids ?? new Set()),
  );
}
