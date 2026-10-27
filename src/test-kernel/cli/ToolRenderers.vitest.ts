// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI rendering
import { toolUseDisplayLines } from '@cli/chat/tui/panes/toolRenderers';

// Local imports - shared schemas
import { TOOL_CALL_STATUS, type NormalizedToolUse } from '@shared/schemas';
import { toolRowModel } from '@shared/transcript/toolRowModel';

// Local imports - test support
import type { ToolRow } from '@shared/transcript/transcriptRow';

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  const normalized: NormalizedToolUse = {
    errorText: '',
    outputText: '',
    userInstructionText: '',
    isUserFeedback: false,
    headerSummary: '',
    status: TOOL_CALL_STATUS.COMPLETED,
    toolName,
    input,
    ...overrides,
  };
  return {
    kind: 'tool',
    id: `tool-${toolName}`,
    timestamp: 0,
    level: 'info',
    toolUse: normalized,
    model: toolRowModel(normalized),
    log: {
      toolName: normalized.toolName,
      input: normalized.input,
      status: normalized.status,
    },
  };
}

describe('CLI tool display lines', () => {
  it('paints producer text terminal-safe: no escapes, tabs expanded', () => {
    const command = `echo \u001b]0;title\u0007done`;
    const entry = toolUse(
      'bash',
      { command },
      {
        headerSummary: command,
        outputText: `\u001b[2Jcleared\tcol\rsplit\nkey`,
      },
    );

    const lines = toolUseDisplayLines(entry, { width: 80 });
    const painted = lines.join('\n');
    expect(painted).not.toContain('\u001b');
    expect(painted).not.toContain('\u0007');
    expect(painted).not.toContain('\t');
    // `\r` is a line break counted before the elision budget, not after.
    expect(lines).toContain('  split');
  });
});
