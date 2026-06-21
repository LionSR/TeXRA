// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

interface CorrectAgentYaml {
  description: string;
  prompts: {
    systemPrompt: string;
    userRequest: string;
  };
}

function readCorrectAgent(): CorrectAgentYaml {
  const text = readFileSync(
    resolve(REPO_ROOT, 'packages/extension/resources/agents/correct.yaml'),
    'utf8',
  );
  return yaml.parse(text) as CorrectAgentYaml;
}

describe('correct agent prompt', () => {
  it('keeps proofreading scoped to local corrections', () => {
    const agent = readCorrectAgent();
    const promptText = `${agent.description}\n${agent.prompts.systemPrompt}\n${agent.prompts.userRequest}`;

    expect(promptText).toContain(
      'without changing your writing style or content',
    );
    expect(promptText).toContain('Do not rewrite mathematical content');
    expect(promptText).toContain(
      'Preserve every mathematical claim, equation, theorem statement, and factual assertion.',
    );
    expect(promptText).toContain(
      'Do not change the meaning of math expressions inside inline math, display math, theorem statements, or derivations.',
    );
    expect(promptText).toContain(
      'Preserve valid math delimiter style (`\\(...\\)`, `$...$`, `\\[...\\]`, `$$...$$`, environments), indentation, and spacing by default',
    );
    expect(promptText).toContain(
      'Do not normalize delimiter style merely for preference',
    );
    expect(promptText).toContain(
      'Do not replace a false or unsupported mathematical statement with a different true statement.',
    );
    expect(promptText).toContain(
      'if the input says `(x+1)^2 = x^2 + 1`, keep that equation unchanged',
    );
    expect(promptText).toContain(
      'Mathematical verification belongs to review-oriented agents',
    );
    expect(promptText).not.toContain(
      'Ensure that all mathematical equations are correct',
    );
  });
});
