import { toErrorMessage } from '@common/errors/errorMessage';
import { decideRunModel } from '@model/runModelDecision';
import { AgentCategory } from '@shared/schemas/agent';

import {
  CLI_BUILTIN_DEFAULT_MODEL,
  commandConfigModel,
  resolveKnownCliModelId,
} from './cliConfig';
import { CliUsageError, type CliContext } from './cliContext';
import { initCliPlatform } from './initPlatform';
import { writeTextStderr } from './logSinks';
import { effectiveCliApiMode } from './apiAccessMode';
import { selectCliRunnableModel } from './modelAccess';
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

function cliSourceForDecision(source: string): CliRunModelCandidateSource {
  switch (source) {
    case 'explicit-override':
      return 'override';
    case 'environment':
      return 'env';
    case 'command-config':
      return 'config';
    default:
      return 'builtin';
  }
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
export function chooseCliRunModelCandidate(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): CliRunModelCandidate {
  const explicit = assertExplicitModelKnown(modelOverride);
  const decision = decideRunModel([
    { model: explicit, reason: 'explicit-override' },
    { model: context.envModel, reason: 'environment' },
    {
      model: commandConfigModel(context.cliConfig, role),
      reason: 'command-config',
    },
    { model: CLI_BUILTIN_DEFAULT_MODEL, reason: 'builtin-default' },
  ]);
  if (!decision) {
    return { model: CLI_BUILTIN_DEFAULT_MODEL, source: 'builtin' };
  }
  return {
    model: decision.model,
    source: cliSourceForDecision(decision.reason),
  };
}

export async function selectCliRunModel(
  context: CliContext,
  modelOverride: string | undefined,
  role: 'chat' | 'run',
): Promise<string> {
  const candidate = chooseCliRunModelCandidate(context, modelOverride, role);
  await initCliPlatform({ ...context, quietLogs: true });
  const apiMode = effectiveCliApiMode(context);
  try {
    const resolution = await selectCliRunnableModel(candidate.model, {
      fallbackSource: candidate.source,
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
export function buildHeadlessRunContext(context: CliContext): CliContext {
  return {
    ...context,
    quietLogs: true,
    renderRunProgress: shouldRenderRunProgress(context),
  };
}
