import {
  approvalPromptsUnavailable,
  type ApprovalInstructionContext,
} from './approvalPolicyAvailability';
import { CLI_UNAVAILABLE_TOOLS } from './unavailableTools';

export interface CliRuntimeCapabilityOptions {
  readonly runtimeUnavailableTools?: readonly string[];
}

export interface CliRuntimeCapabilities {
  readonly approvalPromptsUnavailable: boolean;
  readonly runtimeUnavailableTools: readonly string[];
}

/**
 * Project CLI host limits into the host-neutral runtime capability vector.
 *
 * The agent runtime should not know which CLI modes can render prompts or
 * durable external-inquiry turns. It only receives the resulting capability
 * data and removes tools or prompt paths accordingly.
 */
export function resolveCliRuntimeCapabilities(
  context: ApprovalInstructionContext,
  options: CliRuntimeCapabilityOptions = {},
): CliRuntimeCapabilities {
  return {
    approvalPromptsUnavailable: approvalPromptsUnavailable(context),
    runtimeUnavailableTools: mergeUnavailableTools(
      CLI_UNAVAILABLE_TOOLS,
      options.runtimeUnavailableTools ?? [],
    ),
  };
}

function mergeUnavailableTools(
  baseTools: readonly string[],
  extraTools: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const toolName of [...baseTools, ...extraTools]) {
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    merged.push(toolName);
  }
  return merged;
}
