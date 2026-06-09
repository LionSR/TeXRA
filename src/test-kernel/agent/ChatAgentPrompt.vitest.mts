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

interface ChatAgentYaml {
  settings: {
    tools: string[];
  };
  prompts: {
    systemPrompt: string;
  };
}

function readChatAgent(): ChatAgentYaml {
  const text = readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/resources/tool_use_agents/chat.yaml',
    ),
    'utf8',
  );
  return yaml.parse(text) as ChatAgentYaml;
}

describe('chat agent prompt', () => {
  it('uses TeXRA delegation for internal subagents instead of inquiry', () => {
    const agent = readChatAgent();
    const systemPrompt = agent.prompts.systemPrompt;

    expect(agent.settings.tools).toContain('delegate_agent');
    expect(agent.settings.tools).toContain('inquiry');
    expect(systemPrompt).toContain('Use `delegate_agent`');
    expect(systemPrompt).toContain('Reserve `inquiry`');
  });
});
