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

interface EngineerAgentYaml {
  name: string;
  settings: { tools: string[] };
  prompts: { systemPrompt: string };
}

function readEngineerAgent(): EngineerAgentYaml {
  const text = readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/resources/tool_use_agents/engineer.yaml',
    ),
    'utf8',
  );
  return yaml.parse(text) as EngineerAgentYaml;
}

describe('engineer agent prompt', () => {
  it('can delegate to tool-use agents', () => {
    expect(readEngineerAgent().settings.tools).toContain('delegate_agent');
  });

  it('grounds its delegation targets in the live Available agents roster', () => {
    const systemPrompt = readEngineerAgent().prompts.systemPrompt;

    // The fix for #6655: the engineer must defer to the agents the delegate_agent
    // tool currently lists, not assume its hardcoded specialists are reachable.
    expect(systemPrompt).toContain('Available agents');
    expect(systemPrompt).toContain('delegate only to');
    expect(systemPrompt).toMatch(/closest available specialist/i);
    // Later steps still name coder/codeReviewer/etc.; the prompt tells the model
    // to read those as roles, not as a guarantee the agent is in the roster.
    expect(systemPrompt).toMatch(/closest match\s+in Available agents/i);
  });

  it('handles a specialist that is absent from the active roster', () => {
    const systemPrompt = readEngineerAgent().prompts.systemPrompt;

    // No silent capability degradation: a missing specialist is done in-house or
    // surfaced to the user, never handed to an unrelated agent.
    expect(systemPrompt).toMatch(/no match in the active\s+roster/i);
    expect(systemPrompt).toMatch(/never silently hand/i);
  });

  it('still documents its ideal software specialist roles', () => {
    const systemPrompt = readEngineerAgent().prompts.systemPrompt;

    for (const role of [
      'coder',
      'codeReviewer',
      'testEngineer',
      'codeSimplifier',
    ]) {
      expect(systemPrompt).toContain(role);
    }
  });
});
