import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import {
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@agent/templates/agentTemplateRenderer';

describe('renderAgentTemplateString', () => {
  it('preserves agent runtime variables for the generated agent', () => {
    const rendered = renderAgentTemplateString(
      [
        'name: {{ AGENT_NAME }}',
        'request: {{ INSTRUCTION }}',
        'input: {{ INPUT_CONTENT }}',
      ].join('\n'),
      {
        AGENT_NAME: 'reviewer',
      },
    );

    assert.match(rendered, /name: reviewer/);
    assert.match(rendered, /request: {{ INSTRUCTION }}/);
    assert.match(rendered, /input: {{ INPUT_CONTENT }}/);
  });

  it('lets explicit caller variables override passthrough defaults', () => {
    const rendered = renderAgentTemplateString('request: {{ INSTRUCTION }}', {
      INSTRUCTION: 'write tests',
    });

    assert.equal(rendered, 'request: write tests');
  });

  it('keeps the default tool-use template list in the agent layer', () => {
    assert.match(DEFAULT_AGENT_TEMPLATE_TOOLS_YAML, / {4}- bash/);
    assert.match(DEFAULT_AGENT_TEMPLATE_TOOLS_YAML, / {4}- read_file/);
  });
});
