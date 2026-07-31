// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import { REPO_ROOT } from '@test/support/repoScan';

interface SetupAgentYaml {
  settings: { tools: string[] };
  prompts: { systemPrompt: string };
}

const agent = yaml.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/resources/tool_use_agents/setup.yaml',
    ),
    'utf8',
  ),
) as SetupAgentYaml;

describe('setup agent credential guidance', () => {
  const { systemPrompt } = agent.prompts;

  it('cannot send an API key through a model-visible tool call', () => {
    expect(agent.settings.tools).not.toContain('set_api_key');
    expect(systemPrompt).toContain(
      'Never ask the user to paste an API key into the conversation',
    );
    expect(systemPrompt).toContain('tell the user to type `/key`');
  });

  it('uses explicit host and access-route concepts', () => {
    expect(systemPrompt).toContain("probe's `host` field is authoritative");
    expect(systemPrompt).toContain('`moonshot`, `MOONSHOT_API_KEY`');
    expect(systemPrompt).toContain('`kimiCode`, `KIMI_CODE_API_KEY`');
    expect(systemPrompt).toContain('Never suggest `KIMI_API_KEY`');
  });

  it('answers concrete credential questions before generic onboarding', () => {
    expect(systemPrompt).toContain(
      "user's first message is already a concrete setup question",
    );
    expect(systemPrompt).toContain('`list_api_keys` before answering');
  });
});
