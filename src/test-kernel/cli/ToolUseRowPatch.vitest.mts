import { describe, expect, it } from 'vitest';

import { toolUsePatchDisplayLines } from '@cli/chat/tui/panes/ToolUseRow';
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';

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

describe('ToolUseRow edit patch rendering', () => {
  it('renders an Edit input as an inline patch preview', () => {
    const rows = toolUsePatchDisplayLines(
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
    const rows = toolUsePatchDisplayLines(
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
    expect(
      toolUsePatchDisplayLines(
        toolUse('Bash', {
          command: 'echo hi',
        }),
      ),
    ).toEqual([]);
    expect(
      toolUsePatchDisplayLines(
        toolUse(
          'Edit',
          {
            path: 'paper.tex',
            old_string: 'old',
            new_string: 'new',
          },
          { isError: true },
        ),
      ),
    ).toEqual([]);
  });
});
