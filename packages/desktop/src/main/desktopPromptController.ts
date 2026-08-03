import { randomUUID } from 'node:crypto';

import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopSettlePromptMessageSchema,
  type DesktopShowPromptMessage,
} from '../shared/desktopPromptMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopPromptInput {
  title: string;
  prompt: string;
  password?: boolean;
}

interface DesktopPromptRenderer {
  postToRenderer(message: unknown): boolean;
}

interface PendingPrompt {
  resolve(value: string | undefined): void;
}

export interface DesktopPromptIpc extends DesktopMessageHandler {
  request(input: DesktopPromptInput): Promise<string | undefined>;
  dispose(): void;
}

/** Owns correlated desktop prompt requests and their exact settlement. */
export class DesktopPromptController implements DesktopPromptIpc {
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(private readonly renderer: DesktopPromptRenderer) {}

  request(input: DesktopPromptInput): Promise<string | undefined> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve });
      const delivered = this.renderer.postToRenderer({
        command: DESKTOP_PROMPT_COMMANDS.SHOW,
        requestId,
        title: input.title,
        prompt: input.prompt,
        password: input.password ?? false,
      } satisfies DesktopShowPromptMessage);
      if (!delivered) this.settle(requestId, undefined);
    });
  }

  handleMessage(message: DesktopCommandMessage): boolean {
    const parsed = DesktopSettlePromptMessageSchema.safeParse(message);
    if (!parsed.success) return false;
    return this.settle(parsed.data.requestId, parsed.data.value ?? undefined);
  }

  dispose(): void {
    for (const requestId of this.pending.keys()) {
      this.settle(requestId, undefined);
    }
  }

  private settle(requestId: string, value: string | undefined): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(value);
    return true;
  }
}
