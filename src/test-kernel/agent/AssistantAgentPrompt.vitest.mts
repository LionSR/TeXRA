// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import { REPO_ROOT } from '@test/support/repoScan';

interface AssistantAgentYaml {
  name: string;
  description: string;
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
      'packages/extension/resources/tool_use_agents/assistant.yaml',
    ),
    'utf8',
  ),
) as AssistantAgentYaml;

describe('assistant agent prompt', () => {
  const { systemPrompt } = agent.prompts;

  it('is named assistant (renamed from chat)', () => {
    expect(agent.name).toBe('assistant');
  });

  it('owns general-purpose delegation guidance in the agent definition', () => {
    expect(agent.description).toContain('General-purpose');
    expect(agent.description).toContain('Prefer a more specialized agent');
    expect(agent.description).toContain('pick assistant');
  });

  it('uses TeXRA delegation for internal subagents instead of inquiry', () => {
    expect(agent.settings.tools).toContain('delegate_agent');
    expect(agent.settings.tools).toContain('inquiry');
    expect(systemPrompt).toContain('Use `delegate_agent`');
    expect(systemPrompt).toContain('Reserve `inquiry`');
  });

  it('mentions every declared tool family in the system prompt', () => {
    for (const tool of [
      'wolfram',
      'zotero',
      'lean_loogle',
      'open_pdf',
      'texcount',
      'memory',
      'codex',
      'claude_code',
      'delegate_workflow',
      'github_subscription',
    ]) {
      expect(systemPrompt).toContain(tool);
    }
  });
});
