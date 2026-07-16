import { z } from 'zod';

export const DESKTOP_PROMPT_COMMANDS = {
  SHOW: 'desktop:showPrompt',
  RESULT: 'desktop:promptResult',
} as const;

export const DesktopShowPromptMessageSchema = z.strictObject({
  command: z.literal(DESKTOP_PROMPT_COMMANDS.SHOW),
  requestId: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  inputType: z.enum(['text', 'password']),
  placeHolder: z.string().optional(),
  value: z.string().optional(),
});

export type DesktopShowPromptMessage = z.infer<
  typeof DesktopShowPromptMessageSchema
>;

export const DesktopPromptResultMessageSchema = z.strictObject({
  command: z.literal(DESKTOP_PROMPT_COMMANDS.RESULT),
  requestId: z.string().min(1),
  value: z.string().optional(),
});

export type DesktopPromptResultMessage = z.infer<
  typeof DesktopPromptResultMessageSchema
>;

export function buildDesktopShowPromptMessage(
  payload: Omit<DesktopShowPromptMessage, 'command'>,
): DesktopShowPromptMessage {
  return { command: DESKTOP_PROMPT_COMMANDS.SHOW, ...payload };
}

export function buildDesktopPromptResultMessage(
  requestId: string,
  value?: string,
): DesktopPromptResultMessage {
  return {
    command: DESKTOP_PROMPT_COMMANDS.RESULT,
    requestId,
    ...(value === undefined ? {} : { value }),
  };
}
