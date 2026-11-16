import { Schema } from 'effect';

export const DESKTOP_PROMPT_COMMANDS = {
  SHOW: 'desktop:showPrompt',
  ANSWER: 'desktop:settlePrompt',
} as const;

export const DesktopShowPromptMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PROMPT_COMMANDS.SHOW),
  requestId: Schema.String.check(Schema.isUUID()),
  title: Schema.String,
  prompt: Schema.String,
  password: Schema.Boolean,
});

export type DesktopShowPromptMessage =
  (typeof DesktopShowPromptMessageSchema)['Type'];

export const DesktopAnswerPromptMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PROMPT_COMMANDS.ANSWER),
  requestId: Schema.String.check(Schema.isUUID()),
  value: Schema.NullOr(Schema.String),
});

export type DesktopAnswerPromptMessage =
  (typeof DesktopAnswerPromptMessageSchema)['Type'];
