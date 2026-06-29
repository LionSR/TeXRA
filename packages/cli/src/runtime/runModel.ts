import { toErrorMessage } from '@common/errors/errorMessage';
import { AgentCategory } from '@shared/schemas/agent';

import {
  CLI_BUILTIN_DEFAULT_MODEL,
  resolveKnownCliModelId,
  resolveConfiguredModel,
} from './cliConfig';
import { CliUsageError, type CliContext } from './cliContext';
import { initCliPlatform } from './initPlatform';
import { writeTextStderr } from './logSinks';
import { effectiveCliApiMode } from './apiAccessMode';
import { selectCliRootModel } from './rootModelSelection';
import { shouldRenderRunProgress } from './runProgressRenderer';
import type { CliModelSelectionSource } from './modelAccess';

export type CliRunModelCandidateSource = Extract<
  CliModelSelectionSource,
  'override' | 'env' | 'config' | 'builtin'
>;

export interface CliRunModelCandidate {
  readonly model: string;
  readonly source: CliRunModelCandidateSource;
}

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

/**
 * Resolve the model candidate for a headless runner with the shared
 * precedence: explicit `-m` > `TEXRA_MODEL` env > configured `chat`/`run`
 * model > builtin. The source is part of the contract because model access
 * fallback policy depends on where the value came from.
 */
export function resolveCliRunModelCandidate(
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

export async function resolveCliRunModel(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): Promise<string> {
  const candidate = resolveCliRunModelCandidate(context, modelOverride, role);
  await initCliPlatform({ ...context, quietLogs: true });
  const apiMode = effectiveCliApiMode(context);
  try {
    const resolution = await selectCliRootModel({
      model: candidate.model,
      modelSource: candidate.source,
      apiMode,
      agentCategory:
        role === 'chat' ? AgentCategory.ToolUse : AgentCategory.Workflow,
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
