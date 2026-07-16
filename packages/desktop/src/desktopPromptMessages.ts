import { z } from 'zod';

export const DESKTOP_PROMPT_COMMANDS = {
  SHOW: 'desktop:showPrompt',
  SETTLE: 'desktop:settlePrompt',
} as const;

export const DesktopShowPromptMessageSchema = z.strictObject({
  command: z.literal(DESKTOP_PROMPT_COMMANDS.SHOW),
  requestId: z.uuid(),
  title: z.string(),
  prompt: z.string(),
  password: z.boolean(),
});

export type DesktopShowPromptMessage = z.infer<
  typeof DesktopShowPromptMessageSchema
>;

export const DesktopSettlePromptMessageSchema = z.strictObject({
  command: z.literal(DESKTOP_PROMPT_COMMANDS.SETTLE),
  requestId: z.uuid(),
  value: z.string().nullable(),
});

export type DesktopSettlePromptMessage = z.infer<
  typeof DesktopSettlePromptMessageSchema
>;

export function buildDesktopShowPromptMessage(
  payload: Omit<DesktopShowPromptMessage, 'command'>,
): DesktopShowPromptMessage {
  return { command: DESKTOP_PROMPT_COMMANDS.SHOW, ...payload };
}

export function buildDesktopSettlePromptMessage(
  requestId: string,
  value: string | null,
): DesktopSettlePromptMessage {
  return { command: DESKTOP_PROMPT_COMMANDS.SETTLE, requestId, value };
}
