// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { RestoreRunConfigInputSchema } from '@controllers/mainView/MainViewStateRestoreController';
import { AgentCategory } from '@shared/schemas';

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

  it.each([
    ['a payload that is neither a run config nor the legacy wrapper', 'nope'],
    ['a wrapper whose config is not an object', { agentConfig: 42 }],
    [
      'a wrapper with a malformed config',
      { agentConfig: { agentCategory: 'not-a-category' } },
    ],
    ['a blank object', {}],
    ['a wrapper around a blank config', { agentConfig: {} }],
    ['an unrelated object', { unrelated: true }],
    ['an object whose only identity is undefined', { agent: undefined }],
    ['direct blank identities', { agent: '', model: '' }],
    ['direct whitespace identities', { agent: '  ', model: '\t' }],
    ['direct blank identity', { agent: '', model: 'sonnet46T' }],
    [
      'legacy-wrapped blank identities',
      { agentConfig: { agent: '', model: '' } },
    ],
    [
      'legacy-wrapped whitespace identities',
      { agentConfig: { agent: '  ', model: '\t' } },
    ],
  ])('rejects %s instead of applying config defaults', (_name, input) => {
    expect(RestoreRunConfigInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['agent', { agent: 'correct' }],
    ['model', { model: 'sonnet46T' }],
  ])('accepts a config identified only by %s', (_name, input) => {
    expect(RestoreRunConfigInputSchema.safeParse(input).success).toBe(true);
  });
});
