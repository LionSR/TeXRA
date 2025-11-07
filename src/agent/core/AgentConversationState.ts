// Third-party imports
import { z } from 'zod';

export class AgentConversationState<TMessage> {
  private readonly messages: TMessage[];

  constructor(messages: TMessage[] = []) {
    this.messages = messages;
  }

  static fromJSON<TMessage>(
    messages: TMessage[],
  ): AgentConversationState<TMessage> {
    return new AgentConversationState([...messages]);
  }

  all(): TMessage[] {
    return this.messages;
  }

  push(...items: TMessage[]): number {
    return this.messages.push(...items);
  }

  replace(messages: TMessage[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
  }

  clear(): void {
    this.messages.length = 0;
  }

  toJSON(): TMessage[] {
    return [...this.messages];
  }
}

export function createConversationStateSchema<T extends z.ZodTypeAny>(
  messageSchema: T,
): z.ZodType<AgentConversationState<z.infer<T>>> {
  return z
    .array(messageSchema)
    .transform((messages) => AgentConversationState.fromJSON(messages));
}
