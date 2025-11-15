export type MessageHandler<TContext> = (
  message: any,
  context: TContext,
) => unknown;

export interface MessageHandlerRegistry<TContext> {
  getHandlers(): Record<string, MessageHandler<TContext>>;
  setHandlers(handlers: Record<string, MessageHandler<TContext>>): void;
  register(
    registerFn: (
      handlers: Record<string, MessageHandler<TContext>>,
    ) => (() => void) | void,
  ): (() => void) | void;
  dispose(): void;
}

export function createMessageHandlerRegistry<TContext>(
  initialHandlers?: Record<string, MessageHandler<TContext>>,
): MessageHandlerRegistry<TContext>;
