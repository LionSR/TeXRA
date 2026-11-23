// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI rendering
import type { ToolCallLog } from '@texra-ai/worldline/schemas';
import {
  toolUseDisplayLines,
  toolUseStyledLines,
} from '@cli/chat/tui/panes/toolRenderers';
import { COLOR_BORDER } from '@cli/tui/ui/colors';

// Local imports - shared schemas
import { TOOL_CALL_STATUS } from '@shared/schemas';
import { toolRowModel } from '@shared/transcript/toolRowModel';
import type { ToolRow } from '@texra-ai/worldline/transcript';

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallLog> = {},
): ToolRow {
  const log: ToolCallLog = {
    status: TOOL_CALL_STATUS.COMPLETED,
    toolName,
    input,
    ...overrides,
  };
  return {
    kind: 'tool',
    id: `tool-${toolName}`,
    seqNo: 1,
    timestamp: 0,
    level: 'info',
    model: toolRowModel(log),
    log,
  };
}

describe('CLI tool display lines', () => {
  it('paints producer text terminal-safe: no escapes, tabs expanded', () => {
    const command = `echo \u001b]0;title\u0007done`;
    const entry = toolUse(
      'bash',
      { command },
      {
        summary: command,
        output: `\u001b[2Jcleared\tcol\rsplit\nkey`,
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

  it('paints a one-line range as its line', () => {
    const lines = toolUseDisplayLines(
      toolUse('read_file', { path: 'main.tex', range: [5, 5] }),
    );
    expect(lines.join('\n')).toContain('main.tex:5');
    expect(lines.join('\n')).not.toContain(':5-5');
  });

  it("does not paint the user's own rejection as an error", () => {
    const [header] = toolUseStyledLines(
      toolUse(
        'bash',
        { command: 'rm -rf build' },
        {
          status: TOOL_CALL_STATUS.FAILED,
          error: 'Rejected by user',
          userInstruction: 'keep the build folder',
        },
      ),
    );
    const dot = header?.kind === 'row' ? header.spans[0] : undefined;
    expect(dot?.color).toBe(COLOR_BORDER);
  });
});
