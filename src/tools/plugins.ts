/**
 * A plugin: one value that is both its manifest row (a stable id plus
 * dashboard copy, the opt-in toggle, the availability probe and the
 * install/auth actions) and what it contributes (its tools, continuation,
 * prompt section, round mode and layers). The harness's built-ins are
 * `@tools/builtinPlugins`; an app passes its list, built-ins included, to
 * `installProcessRuntime`, and the process's `ToolRegistry` holds it in
 * order (`@tools/toolTable`), which every reader takes it from: the Tools
 * dashboard (in list order) and each card's inline settings rows,
 * availability probes, the first-install toggle seed, the switches, a run's
 * injected tools (`@agent/runtime/agentToolResolution`), install/auth
 * actions, `texra tools` guides, and the bundled skills and agents, which a
 * switched-off plugin withholds with its tools.
 *
 * Rules: an id is persisted (the disabled-tools key, and the plugin a run's
 * offered tool records), so it never changes and is never reused; every
 * tool belongs to exactly one plugin (checked when the table is built). No
 * hooks, task kinds or second event channels: a plugin holds state only in
 * its process or session layer and writes rows only of its own kinds,
 * through the one publisher.
 */

// Third-party imports
import { Effect, type Layer, Result } from 'effect';
import { z } from 'zod';

// Local imports
import type { RoundMode } from '@agent/runtime/loop/rounds';
import type { Runs } from '@agent/runtime/runRegistry';
import type {
  RuntimeTool as ITool,
  RuntimeTool,
  ToolServices,
} from '@agent/runtime/ToolServices';
import { StateReadFailed, type StateStore } from '@platform/interfaces';
import type { ToolCategory } from '@shared/settingsView/settingsViewMessages';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingHost } from '@shared/state/stateSettings';
import type {
  ToolAvailabilityChecks,
  ToolProbeServices,
} from '@tools/toolProbes';
import type {
  Continuation,
  PluginHold,
  ProcessPluginLayer,
  PromptSection,
  SessionPluginLayer,
} from '@tools/toolTable';

/** One plugin. */
export interface Plugin {
  /** Stable, persisted identifier (the dashboard item id and toggle key). */
  readonly id: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  /** Its tools, by registered name. */
  readonly tools?: Readonly<Record<string, ITool>>;
  /**
   * Present when the plugin has an external dependency: it is probed, its
   * tools are withheld while the dependency is missing, and the dashboard
   * shows its status and install actions. Without it the plugin is built in
   * and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** Checked for availability but listed on no Tools dashboard. */
  readonly hidden?: boolean;
  /** Product hosts whose Tools dashboard does not list the plugin. */
  readonly unavailableHosts?: readonly SettingHost[];
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
   *  tools are withheld from every agent. It must be probed
   *  (`availability`, `ALWAYS_AVAILABLE` when it needs nothing installed). */
  readonly toggleable?: boolean;
  /** A toggleable plugin a fresh install seeds on rather than off. */
  readonly onByDefault?: true;
  /** Decides what a parked run of its category does next; a run's step pins
   *  it while the plugin is switched on. */
  readonly continuation?: Continuation;
  /** Its section of each request's system text; a run's step pins it while
   *  the plugin is switched on. */
  readonly prompt?: PromptSection;
  /** Drives the runs of one agent category in rounds (`@agent/runtime/loop/rounds`). */
  readonly rounds?: RoundMode;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it (`@tools/liveTools`). A host-supplied one (Copilot's, in VS
   *  Code) is passed with the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** Ships skills / `builtInToolUse` agents in `resources/plugins/<id>/`. */
  readonly skills?: true;
  readonly agents?: true;
  /** Install and sign-in copy and actions for the dashboard and
   *  `texra tools`; only a probed plugin (one with `availability`) has any. */
  readonly setup?: ToolPluginSetup;
}

/**
 * A plugin as its author writes it: its tools, continuation and probe may
 * require `ROut`, the services its own layers serve, beside the harness's.
 * `definePlugin` checks that at compile time (a tool that needs a service no
 * layer of its plugin serves does not compile) and erases it: the table
 * holds every plugin alike, and the step that pins a plugin provides its
 * layers' services to its calls.
 */
export interface PluginDefinition<ROut> extends Omit<
  Plugin,
  'tools' | 'continuation' | 'processLayer' | 'sessionLayer' | 'availability'
> {
  readonly tools?: Readonly<
    Record<string, RuntimeTool<Error, ToolServices | ROut>>
  >;
  readonly continuation?: Continuation<ROut>;
  readonly processLayer?: ProcessPluginLayer<ROut>;
  readonly sessionLayer?: Layer.Layer<ROut, never, Runs | PluginHold>;
  readonly availability?: ToolAvailabilityChecks<ToolProbeServices | ROut>;
}

/** A plugin value from its definition, its own services erased. */
export const definePlugin = <ROut = never>(
  plugin: PluginDefinition<ROut>,
): Plugin => plugin as unknown as Plugin;

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
  return store.get(GlobalStateKey.DISABLED_TOOLS).pipe(
    Effect.flatMap((stored) => Effect.fromResult(storedDisabledTools(stored))),
    Effect.map((ids): ReadonlySet<string> => ids ?? new Set()),
  );
}
