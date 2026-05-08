export type CommandHandler<TActions> = (actions: TActions) => boolean;

export type CommandHandlerMap<
  TId extends string,
  TActions,
> = Partial<Record<TId, CommandHandler<TActions>>>;

export function dispatchCommandFromRegistry<TId extends string, TActions>(
  id: TId,
  registry: CommandHandlerMap<TId, TActions>,
  actions: TActions,
): boolean {
  const handler = registry[id];
  return handler ? handler(actions) : false;
}
