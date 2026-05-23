// Shared validation for the user-supplied `-m` / `--model` flag value used by
// `texra run` and `texra multi-agent run`. Centralizing the check keeps the
// error message and the trim/isKnownCliModel contract in one place so the two
// callers can't drift.

import { CliUsageError } from '../../runtime/cliContext';
import { isKnownCliModel } from '../../runtime/cliConfig';

/**
 * Trim and validate an explicit `-m`/`--model` value.
 *
 * Returns the trimmed model id when the user passed a known model, `undefined`
 * when the flag was absent or empty (callers fall through to env / config /
 * built-in defaults), and throws `CliUsageError` when the user passed an
 * unknown model id — surfacing the typo as exit 2 (Usage) instead of letting
 * it become an exit 1 (AgentError) raised mid-run by the runtime's
 * `MODEL_CONFIGS` lookup.
 */
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
