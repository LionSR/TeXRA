import type { ApprovalInstructionContext } from '@cli/runtime/approvalPolicyAvailability';

import { formatUnavailableApprovalInstruction } from './approvalPolicyInstruction';
import { formatCliRunFileInstruction } from './runFileInstruction';

interface MultiAgentInstructionPreset {
  readonly name: string;
  readonly description: string;
}

const COMPLETENESS_GUIDANCE =
  'Before claiming a result is complete, check the full domain stated by the user, including sign choices, zero and boundary cases, and symmetry branches.';

export function formatMultiAgentRunInstruction(
  preset: MultiAgentInstructionPreset,
  init: {
    readonly inputFiles: readonly string[];
    readonly contextFiles: readonly string[];
    readonly instruction: string;
    readonly approvalContext: ApprovalInstructionContext;
  },
): string {
  const parts = [
    `Run the "${preset.name}" multi-agent team preset.`,
    preset.description,
    'Use the visible workflow and tool-use agents as the team available for delegation.',
    COMPLETENESS_GUIDANCE,
  ];
  const approvalInstruction = formatUnavailableApprovalInstruction(
    init.approvalContext,
  );
  if (approvalInstruction) parts.push(approvalInstruction);
  const inputFileInstruction = formatCliRunFileInstruction({
    inputFiles: init.inputFiles,
    contextFiles: init.contextFiles,
  });
  const instruction = init.instruction.trim();
  if (inputFileInstruction) {
    parts.push(inputFileInstruction);
  } else if (instruction) {
    // Say so explicitly — otherwise orchestrators tend to assume files were
    // attached and delegate file rewrites with invented paths.
    parts.push(
      'No input or context files were attached to this run; work from the user instruction below.',
    );
  }

  if (instruction) {
    parts.push(
      inputFileInstruction
        ? 'Additional user instruction:'
        : 'User instruction:',
      instruction,
    );
  }
  return parts.join('\n\n');
}
