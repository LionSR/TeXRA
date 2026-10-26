// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI rendering
import { toolUseDisplayLines } from '@cli/chat/tui/panes/toolRenderers';

// Local imports - shared schemas
import type { NormalizedToolUse } from '@shared/schemas';

// Local imports - test support
import type { ToolRow } from '@shared/transcript/transcriptRow';
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

describe('CLI tool display lines', () => {
  it('paints producer text terminal-safe: no escapes, tabs expanded', () => {
    const entry = bashOutput(
      `echo \u001b]0;title\u0007done`,
      `\u001b[2Jcleared\tcol\rsplit\nkey`,
    );

    const lines = toolUseDisplayLines(entry, { width: 80 });
    const painted = lines.join('\n');
    expect(painted).not.toContain('\u001b');
    expect(painted).not.toContain('\u0007');
    expect(painted).not.toContain('\t');
    // `\r` is a line break counted before the elision budget, not after.
    expect(lines).toContain('  split');
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
        "  … 11 lines hidden (Ctrl-T to view full output)",
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
    const summary = `Loogle matches: ${'long title '.repeat(20)}`;
    const report = toolUse(
      'lean_loogle',
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
});
