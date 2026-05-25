import { CliUsageError } from '@cli/runtime/cliContext';
import { isKnownCliModel } from '@cli/runtime/cliConfig';

/** Trim `-m`; throw a Usage error for unknown ids; undefined when absent. */
export function assertExplicitModelKnown(
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (!isKnownCliModel(trimmed)) {
    throw new CliUsageError(
      `Model not found: ${trimmed}. Use \`texra models list\` to see available models.`,
    );
  }
  return trimmed;
}
