// Local imports - logger
import type { InstructionHints, TaskGroupInstruction } from '@logger/LogTypes';

export function computeInstructionHints(
  text: string,
): InstructionHints | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const lineCount = normalized.split(/\r?\n/).length;
  if (lineCount <= 6 && normalized.length <= 600) {
    return undefined;
  }

  return { showToggle: true };
}

export function buildTaskGroupInstruction(
  text: string,
  executionId?: string,
): TaskGroupInstruction | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  return {
    text: normalized,
    executionId,
    updatedAt: Date.now(),
    hints: computeInstructionHints(normalized),
  };
}
