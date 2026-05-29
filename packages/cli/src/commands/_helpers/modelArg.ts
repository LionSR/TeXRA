import {
  CLI_BUILTIN_DEFAULT_MODEL,
  isKnownCliModel,
  resolveConfiguredModel,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { shouldRenderRunProgress } from '@cli/runtime/runProgressRenderer';

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

/**
 * Resolve the model for a headless runner with the shared precedence:
 * explicit `-m` > `TEXRA_MODEL` env > configured `chat`/`run` model > builtin.
 */
export function resolveCliRunModel(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): string {
  const explicit = assertExplicitModelKnown(modelOverride);
  return (
    explicit ||
    context.envModel ||
    resolveConfiguredModel(context.cliConfig, role) ||
    CLI_BUILTIN_DEFAULT_MODEL
  );
}

/** Derive the headless run context shared by every CLI runner. */
export function buildHeadlessRunContext(
  context: CliContext,
  model: string,
): CliContext {
  return {
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress: shouldRenderRunProgress(context),
  };
}
