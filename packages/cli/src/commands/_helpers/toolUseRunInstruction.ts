import { formatCliRunFileInstruction } from './runFileInstruction';
import { TERMINAL_RUN_GUIDANCE } from './terminalRunInstruction';

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

  const instruction = init.instruction.trim();
  if (instruction) {
    parts.push(
      fileInstruction ? 'Additional user instruction:' : 'User instruction:',
      instruction,
    );
  }
  return parts.join('\n\n');
}
