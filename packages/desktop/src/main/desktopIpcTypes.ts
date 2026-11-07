import { Effect, Result, Schema } from 'effect';
import type { ProcessServices } from '@texra-ai/harness/host';

/** A renderer command: a named command and whatever fields it carries. */
export const DesktopCommandMessageSchema = Schema.StructWithRest(
  Schema.Struct({ command: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
type DesktopCommandMessage = typeof DesktopCommandMessageSchema.Type;

/** The program one inbound command runs. The window's one router runs it and
 *  reports whatever it fails with. */
export type DesktopCommandRoute = (
  message: DesktopCommandMessage,
) => Effect.Effect<void, Error, ProcessServices>;

/** The commands one surface owns, by name. A command with no entry here has
 *  no owner, and the router says so. */
export type DesktopCommandRoutes = Readonly<
  Record<string, DesktopCommandRoute>
>;

/** A route whose message must match `schema`. One that does not is renderer
 *  drift: logged, and no program runs. */
export function parsedRoute<T>(
  schema: Schema.Codec<T, unknown>,
  handle: (message: T) => Effect.Effect<void, Error, ProcessServices>,
): DesktopCommandRoute {
  return (message) => {
    const parsed = Schema.decodeUnknownResult(schema)(message);
    return Result.isSuccess(parsed)
      ? handle(parsed.success)
      : Effect.sync(() =>
          console.warn(
            `Dropped a malformed ${message.command} message: ${parsed.failure.message}`,
          ),
        );
  };
}

export interface DesktopRenderer {
  postToRenderer(message: unknown): void;
}
