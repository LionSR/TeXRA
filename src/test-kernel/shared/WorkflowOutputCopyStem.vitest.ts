// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { workflowOutputCopyStem } from '@shared/constants/workflowOutput';

describe('Save-as-copy stem', () => {
  it.each([
    ['builtInWorkflow:write-polish', 'polish'],
    ['custom:alpha_beta', 'alpha'],
    ['plugin:alpha-beta', 'alpha'],
    // No `:` reaches a file name: an unknown prefix is kept as `vendor__`.
    ['vendor:alpha_beta', 'vendor'],
  ])('preserves the agent chunk in the stem for %s', (agent, expected) => {
    expect(
      workflowOutputCopyStem({
        base: 'paper',
        agent,
        model: 'gpt-4',
        round: 0,
      }),
    ).toBe(`paper_${expected}_r0_gpt-4`);
  });
});
