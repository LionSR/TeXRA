// Third-party imports
import type { z } from 'zod';

/**
 * Handler for a registry-dispatched command.
 *
 * No-arg commands keep the legacy callable shape for backward compatibility
 * (the existing 10 view-routing handlers and the desktop registry are all
 * no-arg). Parameterized commands declare a Zod schema for their arguments
 * via `definedHandler` — the dispatcher parses the raw arg at the boundary
 * and only calls `run` once parsing succeeds, keeping handlers free of
 * parsing boilerplate.
 *
 * The legacy shape is preserved as a callable so existing entries like
 * `(actions) => actions.showSettings()` still type-check; the new shape
 * is an object with `run` + `argsSchema`.
 */
export type CommandHandler<TActions, TArgs = unknown> =
  | ((actions: TActions) => boolean)
  | TypedCommandHandler<TActions, TArgs>;

export interface TypedCommandHandler<TActions, TArgs> {
  run: (actions: TActions, args: TArgs) => boolean;
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
export function definedHandler<TActions, TArgs>(
  argsSchema: z.ZodType<TArgs>,
  run: (actions: TActions, args: TArgs) => boolean,
): TypedCommandHandler<TActions, TArgs> {
  return { run, argsSchema };
}

export function dispatchCommandFromRegistry<TId extends string, TActions>(
  id: TId,
  registry: CommandHandlerMap<TId, TActions>,
  actions: TActions,
  onUnhandled?: (id: TId) => void,
  rawArgs?: unknown,
): boolean {
  const handler = registry[id];
  if (!handler) {
    onUnhandled?.(id);
    return false;
  }

  // Legacy no-arg handlers stay callable directly.
  if (typeof handler === 'function') return handler(actions);

  // Typed handlers parse the raw arg at the boundary so handlers receive
  // a validated shape. A schema parse failure surfaces as `false` (not
  // handled) so callers can surface the issue to the user/log without the
  // dispatcher swallowing it silently.
  const result = handler.argsSchema.safeParse(rawArgs);
  if (!result.success) {
    onUnhandled?.(id);
    return false;
  }
  return handler.run(actions, result.data);
}
