import {
  formatUnavailableApprovalInstruction,
  type ApprovalInstructionContext,
} from './approvalPolicyInstruction';

interface MultiAgentInstructionPreset {
  readonly name: string;
  readonly description: string;
}

const COMPLETENESS_GUIDANCE =
  'Before claiming a result is complete, check the full domain stated by the user, including sign choices, zero and boundary cases, and symmetry branches.';

function formatInputFileInstruction(
  inputFiles: readonly string[],
): string | undefined {
  if (inputFiles.length === 0) return undefined;
  const fileList = inputFiles
    .map((file) => `- ${JSON.stringify(file)}`)
    .join('\n');
  return [
    'Primary user input files:',
    fileList,
    "Treat these files as the user's task source. Read and use them before delegating work.",
    'Do not substitute unrelated workspace files for the task.',
  ].join('\n');
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
    COMPLETENESS_GUIDANCE,
  ];
  const approvalInstruction = formatUnavailableApprovalInstruction(
    init.approvalContext,
  );
  if (approvalInstruction) parts.push(approvalInstruction);
  const inputFileInstruction = formatInputFileInstruction(init.inputFiles);
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
