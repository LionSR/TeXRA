import {
  formatUnavailableApprovalInstruction,
  type ApprovalInstructionContext,
} from './approvalPolicyInstruction';
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
  });
  if (inputFileInstruction) parts.push(inputFileInstruction);

  const instruction = init.instruction.trim();
  if (instruction) {
    parts.push(
      init.inputFiles.length > 0
        ? 'Additional user instruction:'
        : 'User instruction:',
      instruction,
    );
  }
  return parts.join('\n\n');
}
