// Third-party imports
import type { z } from 'zod';

/**
 * Handler for a registry-dispatched command.
 *
 * A handler's result is whatever its host settles at the native entry:
 * `TResult` defaults to `boolean | Promise<boolean>` (the desktop registry's
 * sync handlers), and a host whose actions are Effect programs instantiates
 * it with the program type and runs it once at its registration boundary.
 * Either way the dispatcher returns the handler's result untouched, so the
 * work stays observable to callers and rejections propagate (a
 * fire-and-forget `void actions.X(); return true;` swallowed them, #3782).
 *
 * No-arg commands are plain callables. Parameterized commands declare a Zod
 * tuple schema for their positional arguments via `definedHandler` — the
 * dispatcher parses the raw argument list at the boundary and only calls
 * `run` once parsing succeeds, keeping handlers free of parsing boilerplate.
 */
export type CommandHandler<
  TActions,
  TArgs extends readonly unknown[] = readonly unknown[],
  TResult = boolean | Promise<boolean>,
> =
  | ((actions: TActions) => TResult)
  | TypedCommandHandler<TActions, TArgs, TResult>;

export interface TypedCommandHandler<
  TActions,
  TArgs extends readonly unknown[],
  TResult = boolean | Promise<boolean>,
> {
  run: (actions: TActions, ...args: TArgs) => TResult;
  argsSchema: z.ZodType<TArgs>;
}

/**
 * Map type for a registry. Each entry can carry its own `TArgs` shape, so
 * the per-entry argument schema is not unified across the map. Callers
 * declare entries with `definedHandler` (or a plain function for no-arg
 * commands) and the dispatcher narrows at lookup time.
 */
type CommandHandlerMap<TId extends string, TActions, TResult> = Partial<
  // `any` here is load-bearing: each entry can declare its own `TArgs`
  // shape via `definedHandler`. Using `unknown` would force-unify across
  // the map and break per-entry inference. The dispatcher is the only
  // consumer of this map and parses raw args through the entry's own
  // schema, so the loose map type doesn't leak into call sites.
  Record<TId, CommandHandler<TActions, any, TResult>>
>;

/**
 * Helper that lets call sites declare a typed handler with full inference
 * for the args parameter. Without this helper, TypeScript can't widen the
 * inline object literal back into the union return type.
 */
export function definedHandler<
  TActions,
  TArgs extends readonly unknown[],
  TResult = boolean | Promise<boolean>,
>(
  argsSchema: z.ZodType<TArgs>,
  run: (actions: TActions, ...args: TArgs) => TResult,
): TypedCommandHandler<TActions, TArgs, TResult> {
  return { run, argsSchema };
}

export type CommandDispatchFailure<TId extends string> =
  | { kind: 'unhandled'; id: TId }
  | { kind: 'invalidArguments'; id: TId; error: z.ZodError };

/**
 * Dispatch a command through its registered handler. Returns the
 * handler's result directly, or `false` when the id is unhandled or its
 * arguments fail to parse.
 */
export function dispatchCommandFromRegistry<
  TId extends string,
  TActions,
  TResult = boolean | Promise<boolean>,
>(
  id: TId,
  registry: CommandHandlerMap<TId, TActions, TResult>,
  actions: TActions,
  onFailure?: (failure: CommandDispatchFailure<TId>) => void,
  ...rawArgs: unknown[]
): TResult | false {
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
