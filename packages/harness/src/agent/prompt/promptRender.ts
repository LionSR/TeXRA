import { Effect, Schema } from 'effect';

import { ensureError } from '@utils/errors/errorMessage';
import type { Environment } from 'nunjucks';

/** A prompt that did not render: the template's own error, `nunjucks`
 *  failing to load, or an `AGENTS.md` that is there and could not be read. */
export class PromptRenderFailed extends Schema.TaggedError<PromptRenderFailed>()(
  'PromptRenderFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const renderFailure = (cause: unknown): PromptRenderFailed =>
  new PromptRenderFailed({ message: ensureError(cause).message, cause });

/**
 * The prompt-rendering environment: an empty loader list, since a prompt is
 * an in-memory string and names no template file (a `null` list would get
 * nunjucks' default `views/` loader; an empty one makes any `{% include %}`
 * fail as "template not found"), and autoescape off, since a prompt is raw
 * text, not HTML. The lazy `nunjucks` import is this module's one foreign
 * async edge; Node's module cache serves every import after the first, and
 * a failed import surfaces on each render. A fresh environment per
 * render costs little: `renderString` compiles the template each call anyway.
 */
const promptEnvironment: Effect.Effect<Environment, PromptRenderFailed> =
  Effect.tryPromise({
    try: () => import('nunjucks'),
    catch: renderFailure,
  }).pipe(
    Effect.map(
      ({ default: nunjucks }) =>
        new nunjucks.Environment([], { autoescape: false }),
    ),
  );

/**
 * Render a prompt string using nunjucks templating.
 *
 * @param prompt The prompt template string
 * @param variables Variables to use in template rendering
 * @returns The rendered prompt; a template error fails with its message
 */
export const renderPrompt = Effect.fn('prompt.render')(function* (
  prompt: string,
  variables: Record<string, unknown>,
): Effect.fn.Return<string, PromptRenderFailed> {
  const environment = yield* promptEnvironment;
  return yield* Effect.try({
    try: () => environment.renderString(prompt, variables),
    catch: renderFailure,
  });
});
