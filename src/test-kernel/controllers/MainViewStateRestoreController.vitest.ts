// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { RestoreRunConfigInputSchema } from '@controllers/mainView/MainViewStateRestoreController';

const WORKFLOW_CONFIG = AgentConfigSchema.parse({
  agentCategory: AgentCategory.Workflow,
  agent: 'correct',
  model: 'sonnet46T',
  instruction: 'Polish the draft.',
  inputFiles: ['main.tex'],
  outputFiles: ['main.out.tex'],
});

describe('RestoreRunConfigInputSchema', () => {
  it('accepts a run config unchanged', () => {
    expect(RestoreRunConfigInputSchema.parse(WORKFLOW_CONFIG)).toEqual(
      WORKFLOW_CONFIG,
    );
  });

  it('unwraps the legacy TaskState wrapper into the run config', () => {
    const parsed = RestoreRunConfigInputSchema.parse({
      agentConfig: WORKFLOW_CONFIG,
      activeFiles: { input: true, context: false, media: false, output: true },
    });

    expect(parsed).toEqual(WORKFLOW_CONFIG);
  });

  it('does not let the wrapper parse as an empty prefaulted config', () => {
    // AgentConfigSchema prefaults every field, so a wrapper reaching the plain
    // member first would silently become a default workflow config.
    const parsed = RestoreRunConfigInputSchema.parse({
      agentConfig: { ...WORKFLOW_CONFIG, agent: 'criticize' },
    });

    expect(parsed.agent).toBe('criticize');
    expect(parsed.inputFiles).toEqual(['main.tex']);
  });

  it('rejects a payload that is neither a run config nor the legacy wrapper', () => {
    expect(RestoreRunConfigInputSchema.safeParse('nope').success).toBe(false);
  });

  it('reports a malformed wrapper instead of restoring a blank config', () => {
    expect(
      RestoreRunConfigInputSchema.safeParse({ agentConfig: 42 }).success,
    ).toBe(false);
    expect(
      RestoreRunConfigInputSchema.safeParse({
        agentConfig: { agentCategory: 'not-a-category' },
      }).success,
    ).toBe(false);
  });
});
