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

interface ReviewAgentYaml {
  settings: {
    tools: string[];
  };
  prompts: {
    systemPrompt: string;
  };
}

function readReviewAgent(): ReviewAgentYaml {
  const text = readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/resources/tool_use_agents/review.yaml',
    ),
    'utf8',
  );
  return yaml.parse(text) as ReviewAgentYaml;
}

describe('review agent prompt', () => {
  it('returns audit reports in-band unless the user requested a file', () => {
    const agent = readReviewAgent();
    const systemPrompt = agent.prompts.systemPrompt;

    expect(systemPrompt).toContain('Return the report in your final response');
    expect(systemPrompt).toContain('when the user explicitly asks');
    expect(systemPrompt).not.toContain('use write_file to save the report');
    expect(agent.settings.tools).not.toContain('write_file');
    expect(agent.settings.tools).not.toContain('edit_file');
  });
});
