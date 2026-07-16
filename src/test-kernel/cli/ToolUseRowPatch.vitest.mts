import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { toolDisplaySpanTextProps } from '@cli/chat/tui/panes/ToolUseRow';
import {
  toolUseDisplayLines,
  toolUseStyledLines,
} from '@cli/chat/tui/panes/toolRenderers';
import type { ConversationEntry } from '@cli/chat/tui/state/cliState';
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<NormalizedToolUse> = {},
): NormalizedToolUse {
  return {
    parsed: {},
    toolName,
    errorText: '',
    outputText: '',
    userInstructionText: '',
    input,
    isError: false,
    isUserFeedback: false,
    headerSummary: '',
    status: TOOL_USE_STATUS.COMPLETED,
    ...overrides,
  };
}

function patchRows(entry: NormalizedToolUse): readonly string[] {
  // The patch block follows the single header row in the display lines.
  return toolUseDisplayLines(entry).slice(1);
}

async function renderBoundedTool(
  entry: NormalizedToolUse,
  maxRows: number,
): Promise<string> {
  const ink = (await import(cliRequire.resolve('ink'))) as any;
  const React = ((await import(cliRequire.resolve('react'))) as any).default;
  const { BoundedTranscriptEntry } =
    await import('@cli/chat/tui/panes/TranscriptEntry');
  const transcriptEntry: ConversationEntry = {
    finalized: false,
    id: 'bounded-tool',
    role: 'tool',
    text: '',
    toolUse: entry,
  };
  return ink.renderToString(
    React.createElement(BoundedTranscriptEntry, {
      entry: transcriptEntry,
      maxRows,
      width: 80,
    }),
    { columns: 80 },
  );
}

describe('ToolUseRow edit patch rendering', () => {
  it('renders an Edit input as an inline patch preview', () => {
    const rows = patchRows(
      toolUse('Edit', {
        path: 'paper.tex',
        old_string: 'We use a CNN.\n',
        new_string: 'We use a transformer.\n',
      }),
    );

    expect(rows).toMatchInlineSnapshot(`
      [
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -We use a CNN.",
        "  +We use a transformer.",
      ]
    `);
  });

  it('renders MultiEdit edits as patch previews for the target file', () => {
    const rows = patchRows(
      toolUse('MultiEdit', {
        file_path: 'paper.tex',
        edits: [
          {
            old_string: 'first claim\n',
            new_string: 'revised first claim\n',
          },
          {
            old_string: 'second claim\n',
            new_string: 'revised second claim\n',
          },
        ],
      }),
    );

    expect(rows).toMatchInlineSnapshot(`
      [
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -first claim",
        "  +revised first claim",
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -second claim",
        "  +revised second claim",
      ]
    `);
  });

  it('falls back for non-edit tools and failed edits', () => {
    // Bash keeps its output pipeline (no patch rows beyond the header).
    expect(
      toolUseDisplayLines(
        toolUse('Bash', {
          command: 'echo hi',
        }),
      ),
    ).toEqual(['● Bash (echo hi)', '⎿ (no output)']);
    // A failed edit shows the error corner instead of a patch preview.
    expect(
      toolUseDisplayLines(
        toolUse(
          'Edit',
          {
            path: 'paper.tex',
            old_string: 'old',
            new_string: 'new',
          },
          { errorText: 'edit failed', isError: true },
        ),
      ),
    ).toEqual(['● Edit (paper.tex)', '⎿ edit failed']);
  });

  it('maps semantic spans to Ink text styles', () => {
    const lines = toolUseStyledLines(
      toolUse(
        'bash',
        { command: 'false' },
        { errorText: 'command failed', isError: true },
      ),
    );
    const errorLine = lines.at(-1);
    expect(errorLine?.kind).toBe('row');
    if (errorLine?.kind !== 'row') throw new Error('expected an error row');

    expect(toolDisplaySpanTextProps(errorLine.spans[0])).toEqual({
      bold: undefined,
      color: undefined,
      dimColor: true,
    });
    expect(toolDisplaySpanTextProps(errorLine.spans[1])).toEqual({
      bold: undefined,
      color: 'red',
      dimColor: false,
    });
  });

  it('renders a styled tail when a tool exceeds its bounded viewport', async () => {
    const rendered = await renderBoundedTool(
      toolUse(
        'bash',
        { command: 'npm test' },
        {
          errorText: 'Command failed (exit 2)',
          isError: true,
          outputText: Array.from(
            { length: 20 },
            (_, index) => `line ${index + 1}`,
          ).join('\n'),
          parsed: { exitCode: 2 },
        },
      ),
      2,
    );

    expect(rendered.split('\n').map((line) => line.trimStart())).toEqual([
      '⎿ exit 2',
      '⎿ Command failed (exit 2)',
    ]);
    expect(rendered).not.toContain('line 20');
    expect(rendered).not.toContain('● bash');
  });
});
