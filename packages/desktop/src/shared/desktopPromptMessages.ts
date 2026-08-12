import { z } from 'zod';

export const DESKTOP_PROMPT_COMMANDS = {
  SHOW: 'desktop:showPrompt',
  SETTLE: 'desktop:settlePrompt',
} as const;

// These schemas deliberately use `z.object` (not `z.strictObject`) for parity
// with every other desktop IPC schema: all of them validate the same
// renderer<->main channel, and unknown-key drift is dev-caught by
// `DesktopOutboundMessageSchema`'s discriminated union plus the route table,
// not by per-surface strictness. See the header of desktopOutboundMessages.ts.

export const DesktopShowPromptMessageSchema = z.object({
  command: z.literal(DESKTOP_PROMPT_COMMANDS.SHOW),
  requestId: z.uuid(),
  title: z.string(),
  prompt: z.string(),
  password: z.boolean(),
});

export type DesktopShowPromptMessage = z.infer<
  typeof DesktopShowPromptMessageSchema
>;

export const DesktopSettlePromptMessageSchema = z.object({
  command: z.literal(DESKTOP_PROMPT_COMMANDS.SETTLE),
  requestId: z.uuid(),
  value: z.string().nullable(),
});

export type DesktopSettlePromptMessage = z.infer<
  typeof DesktopSettlePromptMessageSchema
>;
