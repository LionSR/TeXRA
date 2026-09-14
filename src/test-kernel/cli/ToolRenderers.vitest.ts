// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI rendering
import {
  toolUseDisplayLines,
  toolUseStyledLines,
} from '@cli/chat/tui/panes/toolRenderers';
import { toolDisplaySpanTextProps } from '@cli/chat/tui/panes/ToolUseRow';
import { textDisplayWidth } from '@cli/runtime/terminalText';

// Local imports - shared schemas
import type { NormalizedToolUse } from '@shared/schemas';
import type { ToolRow } from '@shared/transcript';

// Local imports - test support
import { loadInk } from '@test/support/inkTestHarness.ts';
import { toolRowFixture } from '@test/support/transcriptRowFixtures';

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  return toolRowFixture(`tool-${toolName}`, { toolName, input, ...overrides });
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

function bashOutput(
  command: string,
  outputText: string,
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  return toolUse(
    'bash',
    { command },
    { headerSummary: command, outputText, ...overrides },
  );
}

async function renderBoundedTool(
  entry: ToolRow,
  maxRows: number,
): Promise<string> {
  const { ink, React } = await loadInk();
  const { BoundedTranscriptEntry } =
    await import('@cli/chat/tui/panes/TranscriptEntry');
  return ink.renderToString(
    React.createElement(BoundedTranscriptEntry, {
      entry,
      maxRows,
      width: 80,
    }),
    { columns: 80 },
  );
}

describe('CLI tool display lines', () => {
  it('counts wrapped patch rows at the rich terminal width', () => {
    const entry = toolUse('Edit', {
      path: 'paper.tex',
      old_string: 'short\n',
      new_string: `${'a long replacement '.repeat(8)}\n`,
    });

    expect(toolUseDisplayLines(entry, { width: 24 }).length).toBeGreaterThan(
      toolUseDisplayLines(entry).length,
    );
  });

  it('registers edit patch rendering before the universal fallback', () => {
    const entry = toolUse('Edit', {
      path: 'paper.tex',
      old_string: 'We use a CNN.\n',
      new_string: 'We use a transformer.\n',
    });

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● Edit (paper.tex)",
        "⎿ paper.tex",
        "  @@ -1 +1 @@",
        "  -We use a CNN.",
        "  +We use a transformer.",
      ]
    `);
  });

  it('elides long bash output to a head+tail slice with a line marker', () => {
    const entry = bashOutput('seq 20', numberedLines(20));

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (seq 20)",
        "⎿ line 1",
        "  line 2",
        "  line 3",
        "  line 4",
        "  line 5",
        "  line 6",
        "  … +11 lines (Ctrl-T to view full output)",
        "  line 18",
        "  line 19",
        "  line 20",
      ]
    `);
  });

  it('caps a single pathologically long output line instead of rendering it whole', () => {
    const entry = bashOutput(
      "rg -n --fixed-strings 'approved-plan' ~/.nvm",
      'x'.repeat(50_000),
    );

    const lines = toolUseDisplayLines(entry);
    expect(lines).toHaveLength(2);
    expect(lines[1].length).toBeLessThan(2010);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('keeps read_file rows compact instead of printing file contents', () => {
    const entry = toolUse(
      'read_file',
      { path: 'paper.tex' },
      { outputText: 'Large file contents\nwith many lines' },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● read_file (paper.tex)",
      ]
    `);
  });

  it('full transcript prints the output only when the card withholds it', () => {
    // An MCP result section paints the whole output: printing it again under
    // "Full output:" would repeat it (#11968).
    const mcp = toolUse(
      'mcp:fs/read',
      { path: '/x' },
      { outputText: 'line1\nline2\nline3' },
    );
    expect(mcp.model.outputSuppression).toBe('rendered-by-sections');
    const mcpLines = toolUseDisplayLines(mcp, { showFullOutput: true });
    expect(mcpLines).not.toContain('Full output:');

    // An edit's diff is the proposed change; its output is the confirmation
    // plus the user's adjustments, which only the full output shows.
    const edit = toolUse(
      'Edit',
      {
        path: 'paper.tex',
        old_string: 'We use a CNN.\n',
        new_string: 'We use a transformer.\n',
      },
      {
        outputText:
          'Edited paper.tex\n\nUser adjustments to paper.tex:\n+We use a ViT.',
      },
    );
    expect(edit.model.outputSuppression).toBe('rendered-by-sections');
    const editLines = toolUseDisplayLines(edit, { showFullOutput: true });
    expect(editLines).toContain('Full output:');
    expect(editLines).toContain('+We use a ViT.');

    // A header painted cut to its width is not the whole output.
    const summary = `Reported issue #1: ${'long title '.repeat(20)}`;
    const report = toolUse(
      'report_review_issue',
      {},
      { headerSummary: summary, outputText: summary },
    );
    expect(report.model.outputSuppression).toBe('duplicate-of-header');
    expect(
      toolUseDisplayLines(report, { showFullOutput: true, width: 80 }),
    ).toContain('Full output:');

    // A failed edit painted no diff, so its output is not rendered by
    // sections: the card shows it, once, in the output block.
    const failedEdit = toolUse(
      'Edit',
      {
        path: 'paper.tex',
        old_string: 'We use a CNN.\n',
        new_string: 'We use a transformer.\n',
      },
      { outputText: 'old_string not found in paper.tex', status: 'failed' },
    );
    const failedLines = toolUseDisplayLines(failedEdit, {
      showFullOutput: true,
    });
    expect(
      failedLines.filter((line) =>
        line.includes('old_string not found in paper.tex'),
      ),
    ).toHaveLength(1);

    // `file-link`: the card shows only a link, so the full transcript is
    // where the content appears.
    const read = toolUse(
      'read_file',
      { path: 'paper.tex' },
      { outputText: 'Large file contents\nwith many lines' },
    );
    expect(toolUseDisplayLines(read, { showFullOutput: true })).toEqual([
      '● read_file (paper.tex)',
      'Full output:',
      'Large file contents',
      'with many lines',
    ]);
  });

  it('sizes live header previews to the terminal width', () => {
    const command = 'x'.repeat(300);
    const header = (width: number | undefined, toolName = 'bash'): string =>
      toolUseDisplayLines(toolUse(toolName, { command }), { width })[0] ?? '';

    // Wide terminals show more of the command than the historical 80 columns.
    expect(textDisplayWidth(header(200))).toBeGreaterThan(150);
    expect(textDisplayWidth(header(200))).toBeLessThanOrEqual(200);
    // Narrow terminals truncate to fit one row instead of wrapping.
    expect(textDisplayWidth(header(60))).toBeLessThanOrEqual(60);
    expect(textDisplayWidth(header(60))).toBeGreaterThan(40);
    // When the name + chrome already eat the row, drop the preview entirely
    // instead of overflowing into a second row.
    expect(header(20, 'a-rather-long-tool-name')).not.toContain('x');
    // Unknown width falls back to the historical fixed budget.
    expect(textDisplayWidth(header(undefined))).toBeLessThanOrEqual(80 + 12);
    expect(textDisplayWidth(header(undefined))).toBeGreaterThan(60);
  });
});

describe('ToolUseRow edit patch rendering', () => {
  it('renders a styled tail when a tool exceeds its bounded viewport', async () => {
    const rendered = await renderBoundedTool(
      toolUse(
        'bash',
        { command: 'npm test' },
        {
          errorText: 'Command failed (exit 2)',
          status: 'failed',
          outputText: numberedLines(20),
          exitCode: 2,
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
