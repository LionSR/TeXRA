// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import { REPO_ROOT } from '@test/support/repoScan';

interface EngineerAgentYaml {
  name: string;
  settings: { tools: string[] };
  prompts: { systemPrompt: string };
}

const agent = yaml.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/resources/tool_use_agents/engineer.yaml',
    ),
    'utf8',
  ),
) as EngineerAgentYaml;
const systemPrompt = agent.prompts.systemPrompt;

describe('engineer agent prompt', () => {
  it('can delegate to tool-use agents', () => {
    expect(agent.settings.tools).toContain('delegate_agent');
  });

  it('grounds its delegation targets in the live Available agents roster', () => {
    // The fix for #6655: the engineer must defer to the agents the delegate_agent
    // tool currently lists, not assume its hardcoded specialists are reachable.
    expect(systemPrompt).toContain('Available agents');
    expect(systemPrompt).toMatch(/before your first delegation/i);
    // Later steps still name coder/codeReviewer/etc.; the prompt tells the model
    // to read those as roles resolved against the live list, not a guarantee.
    expect(systemPrompt).toMatch(/closest match\s+in it/i);
  });

  it('handles a specialist that is absent from the active roster', () => {
    // No silent capability degradation: a missing specialist is done in-house or
    // surfaced to the user, never handed to an unrelated agent.
    expect(systemPrompt).toMatch(/no match/i);
    expect(systemPrompt).toMatch(/yourself or tell the user/i);
    expect(systemPrompt).toMatch(
      /never hand\s+software work to an unrelated agent/i,
    );
  });

  it('still documents its ideal software specialist roles', () => {
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
