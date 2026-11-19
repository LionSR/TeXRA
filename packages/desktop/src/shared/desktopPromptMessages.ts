// The main process asking the renderer for a line of text (a key, a name):
// the renderer serves `DesktopPromptRpcs` and main calls it, each `rpc`
// message carried by one command of the window's command channel.
import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

export const DESKTOP_PROMPT_COMMANDS = Object.freeze({
  /** Main to renderer: a message of main's client. */
  SHOW: 'desktop:showPrompt',
  /** Renderer to main: a message of the renderer's server. */
  ANSWER: 'desktop:settlePrompt',
} as const);

/** The prompt the renderer shows: what it answers, or null when the user
 *  cancelled it or another prompt replaced it. */
export const DesktopPromptRpcs = RpcGroup.make(
  Rpc.make('prompt', {
    payload: {
      title: Schema.String,
      prompt: Schema.String,
      password: Schema.Boolean,
    },
    success: Schema.NullOr(Schema.String),
  }),
);

/** An `rpc` message, which `rpc` itself decodes. */
const RpcMessageSchema = Schema.Record(Schema.String, Schema.Unknown);

export const DesktopShowPromptMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PROMPT_COMMANDS.SHOW),
  message: RpcMessageSchema,
});

export const DesktopAnswerPromptMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_PROMPT_COMMANDS.ANSWER),
  message: RpcMessageSchema,
});
