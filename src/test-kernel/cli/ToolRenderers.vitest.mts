// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';

// Local imports - CLI TUI rendering
import {
  pickToolRenderer,
  toolUseDisplayLines,
} from '../../../packages/cli/src/chat/tui/panes/toolRenderers';

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

describe('CLI tool renderer registry', () => {
  it('registers edit patch rendering before the universal fallback', () => {
    const entry = toolUse('Edit', {
      path: 'paper.tex',
      old_string: 'We use a CNN.\n',
      new_string: 'We use a transformer.\n',
    });

    expect(pickToolRenderer(entry)?.key).toBe('edit');
    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● Edit (paper.tex)",
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -We use a CNN.",
        "  +We use a transformer.",
      ]
    `);
  });

  it('renders bash failures with command preview, output, and explicit exit line', () => {
    const entry = toolUse(
      'bash',
      { command: 'npm run lint' },
      {
        errorText: 'Command failed (exit 2)',
        headerSummary: 'npm run lint',
        isError: true,
        outputText: 'checked 12 files\n2 problems found',
        parsed: { output: { exitCode: 2 } },
      },
    );

    expect(pickToolRenderer(entry)?.key).toBe('bash');
    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (npm run lint)",
        "⎿ checked 12 files",
        "  2 problems found",
        "⎿ exit 2",
        "⎿ Command failed (exit 2)",
      ]
    `);
  });

  it('preserves MCP server names as server/tool labels', () => {
    const entry = toolUse(
      'mcp:slack:send',
      { channel: '#drafts', text: 'done' },
      { outputText: 'sent' },
    );

    expect(pickToolRenderer(entry)?.key).toBe('mcp');
    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● slack/send ({"channel":"#drafts","text":"done"})",
        "⎿ sent",
      ]
    `);
  });

  it('keeps unregistered tools on the universal renderer', () => {
    const entry = toolUse('CustomTool', { path: 'paper.tex' });

    expect(pickToolRenderer(entry)).toBeUndefined();
    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● CustomTool (paper.tex)",
        "⎿ (no output)",
      ]
    `);
  });
});
