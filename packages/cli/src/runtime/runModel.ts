import type { RunModelCandidate } from '@model/runModelDecision';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  CLI_BUILTIN_DEFAULT_MODEL,
  commandConfigModel,
  resolveKnownCliModelId,
} from './cliConfig';
import { CliUsageError, type CliContext } from './cliContext';
import { initCliPlatform } from './initPlatform';
import { writeTextStderr } from './logSinks';
import { selectCliRunnableModel } from './modelAccess';
import { shouldRenderRunProgress } from './runProgressRenderer';

/** Trim `-m`; throw a Usage error for unknown ids; undefined when absent. */
export function assertExplicitModelKnown(
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const resolved = resolveKnownCliModelId(trimmed);
  if (!resolved) {
    throw new CliUsageError(
      `Model not found: ${trimmed}. Use \`texra models list\` to see available models.`,
    );
  }
  return resolved;
}

function cliRunModelCandidates(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): RunModelCandidate[] {
  const explicit = assertExplicitModelKnown(modelOverride);
  return [
    { model: explicit, reason: 'explicit-override' },
    { model: context.envModel, reason: 'environment' },
    {
      model: commandConfigModel(context.cliConfig, role),
      reason: 'command-config',
    },
    { model: CLI_BUILTIN_DEFAULT_MODEL, reason: 'builtin-default' },
  ];
}

export async function selectCliRunModel(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): Promise<string> {
  await initCliPlatform({ ...context, quietLogs: true });
  try {
    const resolution = await selectCliRunnableModel(
      cliRunModelCandidates(context, modelOverride, role),
      {},
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
export function buildHeadlessRunContext(context: CliContext): CliContext {
  return {
    ...context,
    quietLogs: true,
    renderRunProgress: shouldRenderRunProgress(context),
  };
}
