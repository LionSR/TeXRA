/**
 * A plugin: what one unit of the harness contributes (its tools, the probe
 * of its dependency, its switch, its continuation, prompt section and
 * layers). The harness's built-ins are `@tools/builtinPlugins`; an app
 * passes its list, built-ins included, to `installProcessRuntime`, and the
 * process's `ToolRegistry` holds it (`@tools/toolTable`), which every
 * reader takes it from: availability probes, the first-install switch seed,
 * the switches, a run's injected tools
 * (`@agent/runtime/agentToolResolution`), and the bundled skills and agents
 * at `resources/plugins/<id>/`, which a switched-off plugin withholds with
 * its tools. How the app shows a plugin is its own record, keyed by id.
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
import type { Runs } from '@agent/runtime/runRegistry';
import type { RuntimeTool, ToolServices } from '@agent/runtime/ToolServices';
import { StateReadFailed, type StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { ToolAvailabilityChecks } from '@tools/toolProbes';
import type {
  Continuation,
  PluginHold,
  ProcessPluginLayer,
  PromptSection,
  RequestDecisionHook,
  SessionPluginLayer,
} from '@tools/toolTable';

/**
 * One plugin: what it contributes to a run. How an app shows it (a
 * dashboard card's copy, its setup guide, its settings rows) is the app's
 * own record, keyed by `id` (TeXRA's is `@tools/pluginCards`).
 */
export interface Plugin {
  /** Stable, persisted identifier (the switch key, the plugin a run's
   *  offered tool records, and the name of its `resources/plugins/<id>/`
   *  directory): lowercase letters, digits and dashes, starting with a
   *  letter or digit. A list with any other id is refused. */
  readonly id: string;
  /** Its tools, by registered name. */
  readonly tools?: Readonly<Record<string, RuntimeTool>>;
  /**
   * Present when the plugin has an external dependency: it is probed, and
   * its tools are withheld while the dependency is missing. Without it the
   * plugin is built in and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** The plugin has a user switch, which a fresh install sets to this
   *  position; while off, its tools are withheld from every agent. It must
   *  be probed (`availability`, `ALWAYS_AVAILABLE` when it needs nothing
   *  installed). Without one the plugin is always on. */
  readonly toggle?: 'on' | 'off';
  /** Tools of this plugin offered to every agent with tools, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting key, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; a script's
   *  run (a document task's) and a text-only persona get none. */
  readonly injectedWhen?: Readonly<Record<string, string | true>>;
  /** Decides what a parked run of its category does next; a run's step pins
   *  it while the plugin is switched on. */
  readonly continuation?: Continuation;
  /** Its section of each request's system text; a run's step pins it while
   *  the plugin is switched on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it (`@tools/liveTools`). A host-supplied one (Copilot's, in VS
   *  Code) is passed with the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** Its side of a decision on a pending request of the kind it owns, run
   *  whether or not it is switched on: the request outlives the switch. */
  readonly decision?: RequestDecisionHook;
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
  /** Probed outside any step, whether or not the plugin is on: it may
   *  require only the process's probe services. Its own process services
   *  are offered while its layer is up, read with `Effect.serviceOption`. */
  readonly availability?: ToolAvailabilityChecks;
}

/** A plugin value from its definition, its own services erased. */
export const definePlugin = <ROut = never>(
  plugin: PluginDefinition<ROut>,
): Plugin => plugin as unknown as Plugin;

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
