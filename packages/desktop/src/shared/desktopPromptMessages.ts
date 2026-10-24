import { Schema } from 'effect';

export const DESKTOP_PROMPT_COMMANDS = {
  SHOW: 'desktop:showPrompt',
  SETTLE: 'desktop:settlePrompt',
} as const;

// These schemas deliberately use `z.object` (not `z.strictObject`) for parity
// with every other desktop IPC schema: all of them validate the same
// renderer<->main channel, and unknown-key drift is dev-caught by
// `DesktopOutboundMessageSchema`'s discriminated union plus the route table,
// not by per-surface strictness. See the header of desktopOutboundMessages.ts.

export const DesktopShowPromptMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PROMPT_COMMANDS.SHOW),
  requestId: Schema.String.check(Schema.isUUID()),
  title: Schema.String,
  prompt: Schema.String,
  password: Schema.Boolean,
});

export type DesktopShowPromptMessage =
  (typeof DesktopShowPromptMessageSchema)['Type'];

export const DesktopSettlePromptMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PROMPT_COMMANDS.SETTLE),
  requestId: Schema.String.check(Schema.isUUID()),
  value: Schema.NullOr(Schema.String),
});

export type DesktopSettlePromptMessage =
  (typeof DesktopSettlePromptMessageSchema)['Type'];
