// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { ParsedCreatorYamlSchema } from '@commands/agent/agentCreatorCommands';

// Schema-boundary contract for the bundled agent-creator templates (#8187):
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
    retryPrompt: 'Try again: {{ VALIDATION_ERROR }}\n',
  },
};

describe('bundled agent-creator template schema', () => {
  it.each(['agentCreatorWorkflow.yaml', 'agentCreatorToolUse.yaml'])(
    '%s parses with prompt content preserved verbatim',
    (fileName) => {
      const raw = yaml.parse(
        readFileSync(resolve(TEMPLATES_DIR, fileName), 'utf8'),
      );
      const parsed = ParsedCreatorYamlSchema.parse(raw);
      // No trimming or other rewriting of multiline block-scalar prompts.
      expect(parsed.prompts).toEqual(raw.prompts);
      expect(parsed.prompts.systemPrompt.endsWith('\n')).toBe(true);
    },
  );

  it('accepts top-level metadata keys without prompts-level leniency', () => {
    expect(ParsedCreatorYamlSchema.parse(VALID).prompts).toEqual(VALID.prompts);
  });

  it.each(['systemPrompt', 'userRequest', 'retryPrompt'])(
    'rejects empty or whitespace-only %s',
    (field) => {
      for (const blank of ['', '  \n']) {
        const result = ParsedCreatorYamlSchema.safeParse({
          ...VALID,
          prompts: { ...VALID.prompts, [field]: blank },
        });
        expect(result.success).toBe(false);
      }
    },
  );

  it('rejects misspelled keys inside prompts instead of stripping them', () => {
    const { retryPrompt, ...rest } = VALID.prompts;
    const result = ParsedCreatorYamlSchema.safeParse({
      ...VALID,
      prompts: { ...rest, retryPromt: retryPrompt },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('retryPromt');
  });

  it('rejects a missing required prompt field', () => {
    const { userRequest: _omitted, ...rest } = VALID.prompts;
    expect(
      ParsedCreatorYamlSchema.safeParse({ ...VALID, prompts: rest }).success,
    ).toBe(false);
  });
});
