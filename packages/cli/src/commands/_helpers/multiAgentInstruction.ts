import {
  formatUnavailableApprovalInstruction,
  type ApprovalInstructionContext,
} from './approvalPolicyInstruction';

interface MultiAgentInstructionPreset {
  readonly name: string;
  readonly description: string;
}

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
  ];
  const approvalInstruction = formatUnavailableApprovalInstruction(
    init.approvalContext,
  );
  if (approvalInstruction) parts.push(approvalInstruction);

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
