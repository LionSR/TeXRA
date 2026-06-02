import {
  CLI_BUILTIN_DEFAULT_MODEL,
  isKnownCliModel,
  resolveConfiguredModel,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { writeTextStderr } from '@cli/runtime/logSinks';
import { resolveCliRunnableModel } from '@cli/runtime/modelAccess';
import { shouldRenderRunProgress } from '@cli/runtime/runProgressRenderer';
import { effectiveCliApiMode } from '@cli/runtime/apiAccessMode';
import { toErrorMessage } from '@common/errors/errorMessage';

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
export function resolveCliRunModelCandidate(
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

export async function resolveCliRunModel(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): Promise<string> {
  const model = resolveCliRunModelCandidate(context, modelOverride, role);
  const explicitModelRequested = Boolean(
    modelOverride?.trim() || context.envModel?.trim(),
  );
  await initCliPlatform({ ...context, quietLogs: true });
  const apiMode = effectiveCliApiMode(context);
  try {
    const resolution = await resolveCliRunnableModel(model, {
      allowFallback: !explicitModelRequested,
      apiMode,
      noAvailableModelsMessage:
        apiMode === 'included'
          ? 'Run `texra login` for included relay access, or retry with `--api-mode personal` after configuring a provider API key.'
          : undefined,
    });
    if (resolution.notice && context.quietLogs !== true) {
      writeTextStderr(resolution.notice);
    }
    return resolution.model;
  } catch (error: unknown) {
    throw new CliUsageError(toErrorMessage(error));
  }
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
