/**
 * The instruction text of the CLI's headless agent runs: terminal-run
 * guidance, the attached files, then the user's instruction.
 */
import { Predicate } from 'effect';

const TERMINAL_RUN_GUIDANCE =
  'This CLI run exits after your final response. Do not end by asking the user whether to perform more work; either complete the requested work now or state the exact artifacts and next command/action for a future run.';

function formatCliRunFileInstruction(init: {
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
  ].filter(Predicate.isNotUndefined);

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

  // "Additional user instruction:" when file instructions already precede
  // it, "User instruction:" when it stands alone; nothing when it is empty.
  const instruction = init.instruction.trim();
  if (instruction) {
    parts.push(
      fileInstruction ? 'Additional user instruction:' : 'User instruction:',
      instruction,
    );
  }
  return parts.join('\n\n');
}
