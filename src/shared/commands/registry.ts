export type CommandHandler<TActions> = (actions: TActions) => boolean;

type CommandHandlerMap<TId extends string, TActions> = Partial<
  Record<TId, CommandHandler<TActions>>
>;

export function dispatchCommandFromRegistry<TId extends string, TActions>(
  id: TId,
  registry: CommandHandlerMap<TId, TActions>,
  actions: TActions,
  onUnhandled?: (id: TId) => void,
): boolean {
  const handler = registry[id];
  if (handler) return handler(actions);
  onUnhandled?.(id);
  return false;
}
