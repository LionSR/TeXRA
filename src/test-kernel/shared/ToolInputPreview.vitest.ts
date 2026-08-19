import { describe, expect, it } from 'vitest';

import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';

describe('deriveToolInputPreview', () => {
  it.each([
    {
      label: 'reads the command field for bash',
      tool: 'bash',
      input: { command: 'npm test' },
      expected: 'npm test',
    },
    {
      label: 'reads the prompt field for codex',
      tool: 'codex',
      input: { prompt: 'Summarize this proof.' },
      expected: 'Summarize this proof.',
    },
    {
      label: 'composes action and path for executions',
      tool: 'executions',
      input: { action: 'view', path: '/executions/process-1' },
      expected: 'view /executions/process-1',
    },
    {
      label: 'defaults the executions action when omitted',
      tool: 'executions',
      input: { path: '/executions/abc' },
      expected: 'view /executions/abc',
    },
    {
      label: 'uses workflow metadata instead of raw JavaScript',
      tool: 'delegate_multi_agents',
      input: {
        script:
          "export const meta = { name: 'Review team', description: 'Review' };",
      },
      expected: 'Review team',
    },
    {
      label: 'uses the saved workflow path for durable retries',
      tool: 'delegate_multi_agents',
      input: { scriptPath: '.texra/workflow-scripts/review.mjs' },
      expected: '.texra/workflow-scripts/review.mjs',
    },
    {
      label: 'normalizes a provider-namespaced name before the lookup',
      tool: 'claude:Bash',
      input: { command: 'npm test' },
      expected: 'npm test',
    },
    {
      label: 'falls back to the generic target key for unmapped tools',
      tool: 'read_file',
      input: { path: 'paper.tex' },
      expected: 'paper.tex',
    },
    {
      label: 'returns an empty string when the input names nothing',
      tool: 'read_file',
      input: { recursive: true },
      expected: '',
    },
    {
      label: 'returns an empty string for non-object input',
      tool: 'bash',
      input: 'npm test',
      expected: '',
    },
    {
      label: 'returns an empty string for missing input',
      tool: 'bash',
      input: undefined,
      expected: '',
    },
  ])('$label', ({ tool, input, expected }) => {
    expect(deriveToolInputPreview(tool, input)).toBe(expected);
  });
});
