import { Schema } from 'effect';

/** An opening prompt that could not be built: an `AGENTS.md` that is there
 *  and could not be read. */
export class PromptRenderFailed extends Schema.TaggedError<PromptRenderFailed>()(
  'PromptRenderFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** `{{ NAME }}`, with any spacing inside the braces. */
const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Fill a prompt's variables: each `{{ NAME }}` whose name is a key of
 * `variables` becomes that value, in one pass, so a value is never read for
 * variables itself. Everything else stays as written, an unknown name and
 * any other brace expression included: a prompt is text an embedder may take
 * from anyone, and nothing in it is evaluated.
 */
export function renderPrompt(
  prompt: string,
  variables: Readonly<Record<string, string>>,
): string {
  return prompt.replace(VARIABLE, (written, name: string) =>
    Object.hasOwn(variables, name) ? (variables[name] ?? written) : written,
  );
}
