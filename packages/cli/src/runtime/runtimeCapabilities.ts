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
    // Dedupe, keeping first-seen order (Set preserves insertion order).
    runtimeUnavailableTools: [
      ...new Set([
        ...CLI_UNAVAILABLE_TOOLS,
        ...(options.runtimeUnavailableTools ?? []),
      ]),
    ],
  };
}
