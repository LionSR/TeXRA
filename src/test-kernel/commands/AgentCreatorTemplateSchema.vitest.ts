// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { buildCreatorConfig } from '@agent/implementations/agentCreator/agentCreatorFlow';

// Public loader-boundary contract for the bundled agent-creator templates (#8187):
// malformed prompt blocks must fail loudly at load instead of silently
// stripping misspelled keys or handing empty prompts to the helper model.
const TEMPLATES_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
  'packages/extension/resources/templates',
);

const VALID = {
  name: 'example',
  description: 'Example template metadata.',
  settings: { agentCategory: 'internal' },
  prompts: {
    systemPrompt: 'You are a system prompt.\n',
    userRequest: 'Generate the thing.\n',
  },
};

function buildWithWorkflowPrompts(prompts: Record<string, unknown>) {
  return buildCreatorConfig({
    workflowYaml: yaml.stringify({ ...VALID, prompts }),
    toolUseYaml: yaml.stringify(VALID),
    workflowSingle: 'workflow template bytes\n',
    toolUseTpl: 'tool-use template bytes\n',
  });
}

describe('bundled agent-creator template loading', () => {
  it.each(['systemPrompt', 'userRequest'])(
    'rejects empty or whitespace-only %s',
    (field) => {
      for (const blank of ['', '  \n']) {
        expect(() =>
          buildWithWorkflowPrompts({
            ...VALID.prompts,
            [field]: blank,
          }),
        ).toThrow('prompt must not be empty');
      }
    },
  );

  it('rejects misspelled keys inside prompts instead of stripping them', () => {
    expect(() =>
      buildWithWorkflowPrompts({
        ...VALID.prompts,
        userRequst: 'Generate the thing.\n',
      }),
    ).toThrow('userRequst');
  });
});
