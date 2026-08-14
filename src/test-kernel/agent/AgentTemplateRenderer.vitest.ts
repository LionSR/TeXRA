import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@agent/templates/agentTemplateRenderer';
import {
  buildUserVarPassthrough,
  USER_VAR_RUNTIME_TOKENS,
} from '@agent/prompt/userVars';

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

    expect(rendered).toMatch(/name: reviewer/);
    expect(rendered).toMatch(/request: {{ INSTRUCTION }}/);
    expect(rendered).toMatch(/input: {{ INPUT_CONTENT }}/);
  });

  it('lets explicit caller variables override passthrough defaults', () => {
    const rendered = renderAgentTemplateString('request: {{ INSTRUCTION }}', {
      INSTRUCTION: 'write tests',
    });

    expect(rendered).toBe('request: write tests');
  });

  it('keeps the default tool-use template list in the agent layer', () => {
    expect(DEFAULT_AGENT_TEMPLATE_TOOLS_YAML).toMatch(/ {4}- bash/);
    expect(DEFAULT_AGENT_TEMPLATE_TOOLS_YAML).toMatch(/ {4}- read_file/);
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

    expect(rendered).toMatch(/\{\{ ALL_CONTEXTS \}\}/);
  });

  it('derives passthrough variables from the shared user-vars owner', () => {
    expect(USER_VAR_RUNTIME_TOKENS.includes('ALL_CONTEXTS')).toBe(true);
    expect(USER_VAR_RUNTIME_TOKENS.includes('LIST_OF_ALL_CONTEXTS')).toBe(true);

    const passthrough = buildUserVarPassthrough();
    expect(passthrough.ALL_CONTEXTS).toBe('{{ ALL_CONTEXTS }}');
    expect(passthrough.LIST_OF_ALL_CONTEXTS).toBe('{{ LIST_OF_ALL_CONTEXTS }}');
  });
});
