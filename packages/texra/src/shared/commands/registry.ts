// Third-party imports
import { Result, Schema } from 'effect';

/**
 * Handler for a registry-dispatched command.
 *
 * A handler's result is whatever its host finishes at the native entry:
 * `TResult` defaults to `boolean | Promise<boolean>` (the desktop registry's
 * sync handlers), and a host whose actions are Effect programs instantiates
 * it with the program type and runs it once at its registration boundary.
 * Either way the dispatcher returns the handler's result untouched, so the
 * work stays observable to callers and rejections propagate (a
 * fire-and-forget `void actions.X(); return true;` swallowed them, #3782).
 *
 * No-arg commands are plain callables. Parameterized commands declare a
 * tuple schema for their positional arguments via `definedHandler` — the
 * dispatcher parses the raw argument list at the boundary and only calls
 * `run` once parsing succeeds, keeping handlers free of parsing boilerplate.
 */
export type CommandHandler<TActions, TResult = boolean | Promise<boolean>> =
  ((actions: TActions) => TResult) | TypedCommandHandler<TActions, TResult>;

/**
 * A parameterized handler: `dispatch` decodes the raw argument list against
 * the handler's own tuple schema and runs it only on success. The argument
 * type stays inside the closure `definedHandler` builds, so a registry map
 * holds entries with different argument tuples under one type.
 */
export interface TypedCommandHandler<
  TActions,
  TResult = boolean | Promise<boolean>,
> {
  readonly dispatch: (
    actions: TActions,
    rawArgs: readonly unknown[],
  ) => Result.Result<TResult, Schema.SchemaError>;
}

/**
 * Map type for a registry. Callers declare entries with `definedHandler` (or
 * a plain function for no-arg commands).
 */
type CommandHandlerMap<TId extends string, TActions, TResult> = Partial<
  Record<TId, CommandHandler<TActions, TResult>>
>;

/**
 * Declare a typed handler with full inference for the args parameter. The
 * positional argument list is decoded at the boundary so `run` receives
 * validated values; an argument object carrying a key its schema does not
 * declare is refused, not stripped.
 */
export function definedHandler<
  TActions,
  S extends Schema.Codec<readonly unknown[], unknown>,
  TResult = boolean | Promise<boolean>,
>(
  argsSchema: S,
  run: (actions: TActions, ...args: [...S['Type']]) => TResult,
): TypedCommandHandler<TActions, TResult> {
  const decode = Schema.decodeUnknownResult(argsSchema, {
    onExcessProperty: 'error',
  });
  return {
    dispatch: (actions, rawArgs) =>
      Result.map(decode(rawArgs), (args) => run(actions, ...args)),
  };
}

export type CommandDispatchFailure<TId extends string> =
  | { kind: 'unhandled'; id: TId }
  | { kind: 'invalidArguments'; id: TId; error: Schema.SchemaError };

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

  // A no-arg handler is a plain callable.
  if (typeof handler === 'function') return handler(actions);

  // A decoding failure surfaces as `false` so callers can surface the
  // invalid payload distinctly from a genuinely unhandled command id.
  const result = handler.dispatch(actions, rawArgs);
  if (Result.isFailure(result)) {
    onFailure?.({ kind: 'invalidArguments', id, error: result.failure });
    return false;
  }
  return result.success;
}
