import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, it } from 'vitest';

import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@agent/templates/agentTemplateRenderer';
import {
  buildUserVarPassthrough,
  USER_VAR_RUNTIME_TOKENS,
} from '@agent/utils/userVars';

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

  it('keeps {{ ALL_CONTEXTS }} literal when the settings-view creation path renders the bundled workflow template (issue #7678)', () => {
    // The settings-view agent-creation path (agentHandlers.ts createAgentFromTemplate)
    // only supplies AGENT_NAME/DESCRIPTION/TOOLS_YAML, so {{ ALL_CONTEXTS }} must
    // survive via AGENT_RUNTIME_TOKENS passthrough or nunjucks blanks it in the written YAML.
    const templatePath = path.join(
      process.cwd(),
      'packages/extension/resources/templates',
      AGENT_TEMPLATE_FILES.workflowSingle,
    );
    const raw = readFileSync(templatePath, 'utf8');

    const rendered = renderAgentTemplateString(raw, {
      AGENT_NAME: 'my_agent',
      DESCRIPTION: 'a test agent',
    });

    assert.match(rendered, /\{\{ ALL_CONTEXTS \}\}/);
  });

  it('derives passthrough variables from the shared user-vars owner', () => {
    assert.ok(USER_VAR_RUNTIME_TOKENS.includes('ALL_CONTEXTS'));
    assert.ok(USER_VAR_RUNTIME_TOKENS.includes('LIST_OF_ALL_CONTEXTS'));

    const passthrough = buildUserVarPassthrough();
    assert.equal(passthrough.ALL_CONTEXTS, '{{ ALL_CONTEXTS }}');
    assert.equal(
      passthrough.LIST_OF_ALL_CONTEXTS,
      '{{ LIST_OF_ALL_CONTEXTS }}',
    );
  });
});
