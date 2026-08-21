/**
 * Run-instruction text builders shared by the CLI's headless run commands:
 * terminal-run guidance, file-attachment framing, approval-unavailability
 * notices, and the tool-use/multi-agent instruction assemblers built on top
 * of them. Formerly one file per concern under `_helpers/`.
 */
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';

type ApprovalRunContext = {
  readonly mode: 'headless' | 'interactive';
  readonly approvalPolicy: TexraApprovalPolicy;
};

const TERMINAL_RUN_GUIDANCE =
  'This CLI run exits after your final response. Do not end by asking the user whether to perform more work; either complete the requested work now or state the exact artifacts and next command/action for a future run.';

export function formatCliRunFileInstruction(init: {
  readonly inputFiles: readonly string[];
  readonly contextFiles?: readonly string[];
}): string | undefined {
  const parts = [
    formatFileListInstruction({
      title: 'Primary user input files:',
      files: init.inputFiles,
      guidance: [
        "Treat these files as the user's task source. Read and use them before delegating work.",
        'Do not substitute unrelated workspace files for the task.',
      ],
    }),
    formatFileListInstruction({
      title: 'Read-only context files:',
      files: init.contextFiles ?? [],
      guidance: [
        'Use these files as supporting context for the task.',
        'Do not modify them unless the user explicitly asks for edits.',
      ],
    }),
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function formatFileListInstruction(init: {
  readonly title: string;
  readonly files: readonly string[];
  readonly guidance: readonly string[];
}): string | undefined {
  if (init.files.length === 0) return undefined;
  const fileList = init.files.map((file) => `- ${JSON.stringify(file)}`);
  return [init.title, ...fileList, ...init.guidance].join('\n');
}

/** Shared by both assemblers below: label the instruction "Additional user
 * instruction:" when file instructions already precede it, "User
 * instruction:" when it stands alone; no-op when the instruction is empty. */
function appendUserInstruction(
  parts: string[],
  fileInstruction: string | undefined,
  instruction: string,
): void {
  if (!instruction) return;
  parts.push(
    fileInstruction ? 'Additional user instruction:' : 'User instruction:',
    instruction,
  );
}

export function formatToolUseAgentRunInstruction(init: {
  readonly inputFiles: readonly string[];
  readonly contextFiles: readonly string[];
  readonly instruction: string;
}): string {
  const parts = [TERMINAL_RUN_GUIDANCE];
  const fileInstruction = formatCliRunFileInstruction({
    inputFiles: init.inputFiles,
    contextFiles: init.contextFiles,
  });
  if (fileInstruction) parts.push(fileInstruction);

  appendUserInstruction(parts, fileInstruction, init.instruction.trim());
  return parts.join('\n\n');
}

const PRIVILEGED_ACTION_GUIDANCE =
  'Do not call approval-gated tools such as bash/shell commands, file edits, setup/config updates, user questions, retry/plan approvals, or new subagent delegations; solve from the provided context or state what approval is needed.';
const CLI_APPROVAL_POLICY_GUIDANCE =
  'Valid CLI approval policies are "ask", "never", and "yolo" only. If suggesting a rerun, use --approval-policy yolo for headless auto-approval or an interactive run with --approval-policy ask; do not invent other approval mode names.';

export function formatUnavailableApprovalInstruction(
  context: ApprovalRunContext,
): string | undefined {
  if (context.approvalPolicy === 'never') {
    return [
      'Approval policy for this run is "never": privileged actions that require approval will be rejected automatically.',
      PRIVILEGED_ACTION_GUIDANCE,
      CLI_APPROVAL_POLICY_GUIDANCE,
    ].join(' ');
  }

  if (context.mode === 'headless' && context.approvalPolicy === 'ask') {
    return [
      'This is a headless run with approval policy "ask": approval prompts cannot be answered, so privileged actions that require approval will be rejected automatically.',
      PRIVILEGED_ACTION_GUIDANCE,
      CLI_APPROVAL_POLICY_GUIDANCE,
    ].join(' ');
  }

  return undefined;
}

interface MultiAgentInstructionPreset {
  readonly name: string;
  readonly description: string;
}

const COMPLETENESS_GUIDANCE =
  'Before claiming a result is complete, internally check the full domain stated by the user, including sign choices, zero and boundary cases, and symmetry branches. Use this as a correctness checklist; do not add a separate checklist or case analysis to the final answer unless the user asks for it, and keep the final answer within the user-requested scope and length.';

export function formatMultiAgentRunInstruction(
  preset: MultiAgentInstructionPreset,
  init: {
    readonly inputFiles: readonly string[];
    readonly contextFiles: readonly string[];
    readonly instruction: string;
    readonly approvalContext: ApprovalRunContext;
    readonly workingDirectory: string;
  },
): string {
  const parts = [
    `Run the "${preset.name}" multi-agent team preset.`,
    preset.description,
    `Workspace root for this run: ${JSON.stringify(init.workingDirectory)}. Resolve relative file paths against this directory, and tell delegated agents to use these same relative paths instead of inventing container roots such as /workspace.`,
    'Use the visible workflow and tool-use agents as the team available for delegation.',
    COMPLETENESS_GUIDANCE,
    TERMINAL_RUN_GUIDANCE,
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

  appendUserInstruction(parts, inputFileInstruction, instruction);
  return parts.join('\n\n');
}
