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
 * injected tools (`@tools/composition`), install/auth actions, `texra tools`
 * guides, and the bundled skills and agents the bootstrap installs, which a
 * switched-off plugin withholds with its tools.
 *
 * Rules: an id is persisted (the disabled-tools key), so it never changes and
 * is never reused; every tool belongs to exactly one plugin (checked below
 * and in the registry). No hooks, task kinds or event channels, and no state
 * but a `layer`: a plugin is data, re-registered by code at every startup.
 */

// Local imports
import type { ToolCategory } from '@shared/settingsView/settingsViewMessages';
import type { ToolAvailabilityChecks } from '@tools/toolProbes';
import { MANIFEST } from '@tools/pluginManifest';

/** One tool plugin. */
export interface ToolPlugin {
  /** Stable, persisted identifier (the dashboard item id and toggle key). */
  readonly id: string;
  /** The registered tools this plugin provides; `@tools/registry` checks
   *  them. Empty only for a plugin that contributes a continuation policy. */
  readonly toolNames: readonly [string, ...string[]] | readonly [];
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
   *  injected tool still passes the host and approval gates; reflection
   *  runs get none. */
  readonly injectedWhen?: Readonly<Record<string, string | true>>;
  /** Opt-in: the dashboard shows an enable/disable toggle, a fresh install
   *  seeds the plugin disabled (unless `onByDefault`), and while disabled its
   *  tools are withheld from every agent. */
  readonly toggleable?: boolean;
  /** A toggleable plugin a fresh install seeds on rather than off. */
  readonly onByDefault?: true;
  /** Decides what a parked tool-use run does next: a policy in
   *  `PLUGIN_CONTINUATIONS` (`@agent/runtime/loop/continuationPolicy`), which
   *  a run gets only while its pinned composition includes the plugin. */
  readonly continuation?: true;
  /** Owns resources: a layer in `@tools/registry`, built while an open
   *  composition includes the plugin (`@tools/compositions`). */
  readonly layer?: true;
  /** Ships skills / `builtInToolUse` agents in `resources/plugins/<id>/`. */
  readonly skills?: true;
  readonly agents?: true;
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

/** Look up a plugin by id. */
export function findToolPlugin(id: string): ToolPlugin | undefined {
  return TOOL_PLUGINS.find((plugin) => plugin.id === id);
}
