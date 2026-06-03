import {
  CLI_BUILTIN_DEFAULT_MODEL,
  isKnownCliModel,
  resolveConfiguredModel,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { writeTextStderr } from '@cli/runtime/logSinks';
import {
  cliRunnableModelOptionsForSource,
  resolveCliRunnableModel,
  type CliModelSelectionSource,
} from '@cli/runtime/modelAccess';
import { shouldRenderRunProgress } from '@cli/runtime/runProgressRenderer';
import { effectiveCliApiMode } from '@cli/runtime/apiAccessMode';
import { toErrorMessage } from '@common/errors/errorMessage';

type CliRunModelCandidateSource = Extract<
  CliModelSelectionSource,
  'override' | 'env' | 'config' | 'builtin'
>;

interface CliRunModelCandidate {
  readonly model: string;
  readonly source: CliRunModelCandidateSource;
}

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

function resolveCliRunModelCandidateDetails(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): CliRunModelCandidate {
  const explicit = assertExplicitModelKnown(modelOverride);
  if (explicit) return { model: explicit, source: 'override' };
  if (context.envModel) return { model: context.envModel, source: 'env' };

  const configured = resolveConfiguredModel(context.cliConfig, role);
  if (configured) return { model: configured, source: 'config' };

  return { model: CLI_BUILTIN_DEFAULT_MODEL, source: 'builtin' };
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
  return resolveCliRunModelCandidateDetails(context, modelOverride, role).model;
}

export async function resolveCliRunModel(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): Promise<string> {
  const candidate = resolveCliRunModelCandidateDetails(
    context,
    modelOverride,
    role,
  );
  await initCliPlatform({ ...context, quietLogs: true });
  const apiMode = effectiveCliApiMode(context);
  try {
    const resolution = await resolveCliRunnableModel(
      candidate.model,
      cliRunnableModelOptionsForSource(candidate.source, {
        apiMode,
      }),
    );
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
