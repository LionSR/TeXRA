// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import { REPO_ROOT } from '@test/support/repoScan';

interface ReviewAgentYaml {
  settings: {
    tools: string[];
  };
  prompts: {
    systemPrompt: string;
  };
}

const agent = yaml.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/resources/tool_use_agents/review.yaml',
    ),
    'utf8',
  ),
) as ReviewAgentYaml;

describe('review agent prompt', () => {
  const systemPrompt = agent.prompts.systemPrompt;

  it('returns audit reports in-band unless the user requested a file', () => {
    expect(systemPrompt).toContain('Return the report in your final response');
    expect(systemPrompt).toContain('when the user explicitly asks');
    expect(systemPrompt).toContain(
      'Use write_file for new workspace artifacts',
    );
    expect(systemPrompt).toContain(
      'do not use bash as a workspace file-writing fallback',
    );
    expect(agent.settings.tools).toContain('write_file');
    expect(agent.settings.tools).toContain('edit_file');
  });

  it('prefers direct review over computation for elementary facts', () => {
    expect(systemPrompt).toContain(
      'Prefer direct mathematical review when a claim can be checked by hand',
    );
    expect(systemPrompt).toContain(
      'do not request external computation for elementary facts',
    );
    expect(agent.settings.tools).toContain('wolfram');
    expect(agent.settings.tools).toContain('bash');
  });
});
