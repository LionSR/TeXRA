// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import { REPO_ROOT } from '@test/support/repoScan';

/** A tool-use agent: declares the tool roster its prompt refers to. */
interface ToolUseAgentYaml {
  readonly name: string;
  readonly description: string;
  readonly settings: { readonly tools: string[] };
  readonly prompts: {
    readonly systemPrompt: string;
    readonly userRequest: string;
  };
}

/** A bundled workflow agent: prompts only, no model-facing tool roster. */
type WorkflowAgentYaml = Omit<ToolUseAgentYaml, 'settings'>;

function loadAgentYaml<T>(relativePath: string): T {
  return yaml.parse(
    readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'),
  ) as T;
}

describe('assistant agent prompt', () => {
  const agent = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/assistant.yaml',
  );
  const { systemPrompt } = agent.prompts;

  it('is named assistant', () => {
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

describe('engineer agent prompt', () => {
  const agent = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/engineer.yaml',
  );
  const { systemPrompt } = agent.prompts;

  it('can delegate to tool-use agents', () => {
    expect(agent.settings.tools).toContain('delegate_agent');
  });

  it('can run deterministic workflow scripts when globally enabled', () => {
    expect(agent.settings.tools).toContain('delegate_multi_agents');
    expect(systemPrompt).not.toContain('delegate_multi_agents');
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

describe('Lean orchestrator agent prompt', () => {
  const agent = loadAgentYaml<ToolUseAgentYaml>(
    'prompts/agents/remote/Lean4/leanOrchestrator.yaml',
  );

  it('can run deterministic workflow scripts when globally enabled', () => {
    expect(agent.settings.tools).toContain('delegate_multi_agents');
    expect(agent.prompts.systemPrompt).not.toContain('delegate_multi_agents');
  });
});

describe('review agent prompt', () => {
  const agent = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/review.yaml',
  );
  const { systemPrompt } = agent.prompts;

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

describe('code reviewer prompts', () => {
  const codeReviewer = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/codeReviewer.yaml',
  );
  const changeReviewer = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/changeReviewer.yaml',
  );

  it('uses the concise review finding format', () => {
    expect(codeReviewer.prompts.systemPrompt).toContain(
      '`file:line: problem. Suggested fix: ...`',
    );
  });

  it.each([codeReviewer, changeReviewer])(
    'keeps $name authored copy free of em dashes',
    (agent) => {
      const authoredCopy = `${agent.description}\n${agent.prompts.systemPrompt}`;
      expect(authoredCopy).not.toContain('\u2014');
    },
  );
});

describe('setup agent credential guidance', () => {
  const agent = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/setup.yaml',
  );
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

describe('correct agent prompt', () => {
  const agent = loadAgentYaml<WorkflowAgentYaml>(
    'packages/extension/resources/agents/correct.yaml',
  );

  it('keeps proofreading scoped to local corrections', () => {
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
