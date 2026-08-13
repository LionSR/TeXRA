// Third-party imports
import type { z } from 'zod';

/**
 * Handler for a registry-dispatched command.
 *
 * Handlers may be sync (return `boolean`) or async (return
 * `Promise<boolean>`). The dispatcher returns whatever the handler
 * returns, so async work performed by the handler is observable to
 * callers — they can `await` the dispatch and surface rejections.
 *
 * Returning `void`-ish promises is unsafe inside a handler: the
 * dispatcher would settle before the work finished, swallowing errors
 * (the bug fixed by #3782). Handlers that perform async work must
 * either `return actions.X()` (let the dispatcher forward the promise)
 * or `await` and return `true`.
 *
 * No-arg commands keep the legacy callable shape for backward
 * compatibility (the existing view-routing handlers and the desktop
 * registry are all no-arg). Parameterized commands declare a Zod tuple
 * schema for their positional arguments via `definedHandler` — the
 * dispatcher parses the raw argument list at the boundary and only calls
 * `run` once parsing succeeds, keeping handlers free of parsing boilerplate.
 *
 * The legacy shape is preserved as a callable so existing entries like
 * `(actions) => actions.showSettings()` still type-check; the new shape
 * is an object with `run` + `argsSchema`.
 */
export type CommandHandler<
  TActions,
  TArgs extends readonly unknown[] = readonly unknown[],
> =
  | ((actions: TActions) => boolean | Promise<boolean>)
  | TypedCommandHandler<TActions, TArgs>;

export interface TypedCommandHandler<
  TActions,
  TArgs extends readonly unknown[],
> {
  run: (actions: TActions, ...args: TArgs) => boolean | Promise<boolean>;
  argsSchema: z.ZodType<TArgs>;
}

/**
 * Map type for a registry. Each entry can carry its own `TArgs` shape, so
 * the per-entry argument schema is not unified across the map. Callers
 * declare entries with `definedHandler` (or a plain function for no-arg
 * commands) and the dispatcher narrows at lookup time.
 */
type CommandHandlerMap<TId extends string, TActions> = Partial<
  // `any` here is load-bearing: each entry can declare its own `TArgs`
  // shape via `definedHandler`. Using `unknown` would force-unify across
  // the map and break per-entry inference. The dispatcher is the only
  // consumer of this map and parses raw args through the entry's own
  // schema, so the loose map type doesn't leak into call sites.
  Record<TId, CommandHandler<TActions, any>>
>;

/**
 * Helper that lets call sites declare a typed handler with full inference
 * for the args parameter. Without this helper, TypeScript can't widen the
 * inline object literal back into the union return type.
 */
export function definedHandler<TActions, TArgs extends readonly unknown[]>(
  argsSchema: z.ZodType<TArgs>,
  run: (actions: TActions, ...args: TArgs) => boolean | Promise<boolean>,
): TypedCommandHandler<TActions, TArgs> {
  return { run, argsSchema };
}

/**
 * Wrap a promise-returning action so the dispatcher awaits it before
 * settling. Sync handlers that miss this helper regressed in #3778 — the
 * original `void actions.X(); return true;` shape fired-and-forgot the
 * promise, swallowing rejections (#3782). Handlers should use this helper
 * whenever they delegate to an async action so failures propagate to
 * `executeCommand` callers.
 */
export function awaitTrue(p: PromiseLike<unknown>): Promise<boolean> {
  return Promise.resolve(p).then(() => true);
}

export type CommandDispatchFailure<TId extends string> =
  | { kind: 'unhandled'; id: TId }
  | { kind: 'invalidArguments'; id: TId; error: z.ZodError };

/**
 * Dispatch a command through its registered handler. Returns the
 * handler's result directly — sync handlers settle immediately;
 * async handlers return a promise that callers can `await` so
 * rejections propagate (rather than the fire-and-forget pattern that
 * regressed in #3778 and was caught in #3782).
 */
export function dispatchCommandFromRegistry<TId extends string, TActions>(
  id: TId,
  registry: CommandHandlerMap<TId, TActions>,
  actions: TActions,
  onFailure?: (failure: CommandDispatchFailure<TId>) => void,
  ...rawArgs: unknown[]
): boolean | Promise<boolean> {
  const handler = registry[id];
  if (!handler) {
    onFailure?.({ kind: 'unhandled', id });
    return false;
  }

  // Legacy no-arg handlers stay callable directly.
  if (typeof handler === 'function') return handler(actions);

  // Typed handlers parse the positional argument list at the boundary so
  // handlers receive validated values. A schema parse failure surfaces as
  // `false` so callers can surface the invalid payload distinctly from a
  // genuinely unhandled command id.
  const result = handler.argsSchema.safeParse(rawArgs);
  if (!result.success) {
    onFailure?.({ kind: 'invalidArguments', id, error: result.error });
    return false;
  }
  return handler.run(actions, ...result.data);
}
