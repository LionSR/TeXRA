import { describe, expect, it } from 'vitest';

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

  it.each([
    ['a payload that is not a run config', 'nope'],
    ['the retired TaskState wrapper', { agentConfig: WORKFLOW_CONFIG }],
    ['a blank object', {}],
    ['an unrelated object', { unrelated: true }],
    ['an object whose only identity is undefined', { agent: undefined }],
    ['direct blank identities', { agent: '', model: '' }],
    ['direct whitespace identities', { agent: '  ', model: '\t' }],
    ['direct blank identity', { agent: '', model: 'sonnet46T' }],
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
