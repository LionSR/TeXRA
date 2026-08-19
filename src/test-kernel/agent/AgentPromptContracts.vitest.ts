// Node imports
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// Third-party imports
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import { parseSourceFile, REPO_ROOT } from '@test/support/repoScan';

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

const PROMPT_RESOURCE_DIRS = [
  'packages/extension/resources/tool_use_agents',
  'packages/extension/resources/agents',
  'packages/extension/resources/templates',
  'packages/extension/resources/goal',
  'prompts/agents/remote',
];

const LIQUID_AGENT_TEMPLATES = new Set([
  'packages/extension/resources/templates/agentTemplate-toolUse.yaml',
  'packages/extension/resources/templates/agentTemplate-workflowSingle.yaml',
]);

// These roots own the model transcript, synthetic turns, provider fallbacks,
// built-in tool descriptions, schemas, and tool results. Discovering files from
// the roots keeps the inventory current when a new handler, tool, or helper is
// added. Model-facing builders outside those roots are listed with evidence.
const TYPESCRIPT_MODEL_COPY_DIRS = ['src/agent', 'src/tools'];
const TYPESCRIPT_MODEL_COPY_EXTERNAL_SOURCES = {
  'packages/cli/src/chat/tui/forms/SkillsListForm.tsx':
    'builds the synthetic skill-activation instruction sent with the next user request',
  'packages/cli/src/chat/tui/runChatTui.tsx':
    'wraps pending skill activations and the substantive user request sent to the agent',
  'packages/cli/src/commands/_helpers/runInstructions.ts':
    'builds headless tool-use and multi-agent run instructions',
  'src/controllers/onboarding/setupLaunch.ts':
    'defines the instruction used to launch the setup agent',
  'src/controllers/progressView/ProgressFollowUpController.ts':
    'builds workflow follow-up and compile-fixer agent instructions',
  'src/latex/latexdiff/diffFileNameManager.ts':
    'adds latexdiff-specific guidance to a fixer-agent instruction',
  'src/model/runtimeModelRegistry.ts':
    'sends the model-access consent probe directly to a language model',
  'src/shared/schemas/agentPresets.ts':
    'defines built-in team descriptions inserted into multi-agent run instructions',
  'src/skills/runtimeSkills.ts':
    'formats the skill catalog and activated skill instructions for model context',
  'src/utils/system/workspaceInfo.ts':
    'builds the workspace-information block appended to tool-use system prompts',
} as const;

const BUILTIN_SKILL_SOURCE_DIR = 'skills';
const STOCK_MODEL_PHRASING =
  /\b(?:delve(?:s|d|ing)?|seamlessly|meticulous(?:ly)?|pivotal|tapestry)\b/i;

const SHARED_PROMPT_FRAGMENTS = {
  'packages/extension/resources/shared/latex_style_rules.txt': {
    token: 'LATEX_STYLE_RULES',
    loader: 'src/agent/prompt/userVars.ts',
  },
} as const;

// These are syntax or rendering separators, not prose punctuation. Keep each
// exception tied to the source that consumes that exact serialization format.
const INTENTIONAL_NON_PROMPT_DASH_LITERALS: Readonly<
  Record<
    string,
    { readonly literals: readonly string[]; readonly evidence: string }
  >
> = {
  'src/agent/export/chatExport/markdownSpec.ts': {
    literals: ['---'],
    evidence: 'Markdown horizontal-rule serialization for exported chats',
  },
  'src/tools/lean/LoogleTool.ts': {
    literals: ['\n\n---\n\n'],
    evidence: 'Markdown section separator in a structured tool result',
  },
  'src/tools/lean/direct/directLspAdapter.ts': {
    literals: ['\n---\n'],
    evidence: 'Plain-text separator between Lean LSP result sections',
  },
  'src/tools/memory/memoryMeta.ts': {
    literals: ['---'],
    evidence: 'YAML frontmatter delimiter parsed as metadata, not prompt prose',
  },
  'src/tools/web/WebFetchTool.ts': {
    literals: ['Prompt\n------\n'],
    evidence: 'Setext heading underline in rendered web-fetch output',
  },
};

function listFiles(directory: string, suffix: string): string[] {
  const absoluteDirectory = resolve(REPO_ROOT, directory);
  return (
    (readdirSync(absoluteDirectory, { recursive: true }) as string[])
      .filter((entry) => entry.endsWith(suffix))
      // Normalize to repo-style forward slashes so inventory sets, Windows
      // path.relative() output, and endsWith('/…') checks stay aligned.
      .map((entry) =>
        relative(REPO_ROOT, resolve(absoluteDirectory, entry)).replaceAll(
          '\\',
          '/',
        ),
      )
  );
}

const PROMPT_RESOURCE_FILES = PROMPT_RESOURCE_DIRS.flatMap((directory) =>
  listFiles(directory, '.yaml'),
).sort();
const SHARED_PROMPT_FRAGMENT_FILES = listFiles(
  'packages/extension/resources/shared',
  '.txt',
).sort();
const TYPESCRIPT_MODEL_COPY_INVENTORY = [
  ...TYPESCRIPT_MODEL_COPY_DIRS.flatMap((directory) =>
    listFiles(directory, '.ts'),
  ),
  ...Object.keys(TYPESCRIPT_MODEL_COPY_EXTERNAL_SOURCES),
].sort();
const BUILTIN_SKILL_SOURCE_FILES = listFiles(BUILTIN_SKILL_SOURCE_DIR, '')
  .filter((file) => /\.(?:md|yaml)$/.test(file))
  .sort();

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectStrings);
}

function renderLiquidSkeleton(source: string): string {
  const rendered = source
    .replace(/^{{ TOOLS_YAML }}$/m, '    - read_file')
    .replaceAll(/{%[\s\S]*?%}/g, '')
    .replaceAll(/{{[\s\S]*?}}/g, 'sentinel_value');
  if (/{{|{%/.test(rendered)) throw new Error('Unrendered Liquid marker');
  return rendered;
}

function parsePromptYaml(relativePath: string): Record<string, unknown> {
  const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  const rendered = LIQUID_AGENT_TEMPLATES.has(relativePath)
    ? renderLiquidSkeleton(source)
    : source;
  return yaml.parse(rendered, { strict: true }) as Record<string, unknown>;
}

function authoredYamlCopy(relativePath: string): string {
  const parsed = parsePromptYaml(relativePath);
  const authoredFields = relativePath.endsWith('/goal/goal.yaml')
    ? parsed
    : {
        description: parsed.description,
        prompts: parsed.prompts,
      };
  return collectStrings(authoredFields).join('\n');
}

function authoredSkillCopy(relativePath: string): string {
  // Normalize CRLF so Windows checkouts (core.autocrlf) still match frontmatter.
  const source = readFileSync(
    resolve(REPO_ROOT, relativePath),
    'utf8',
  ).replaceAll('\r\n', '\n');
  if (relativePath.endsWith('.yaml')) {
    return collectStrings(yaml.parse(source, { strict: true })).join('\n');
  }
  if (!relativePath.endsWith('/SKILL.md')) return source;

  const frontmatter = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!frontmatter)
    throw new Error(`Invalid SKILL.md frontmatter: ${relativePath}`);
  return `${collectStrings(yaml.parse(frontmatter[1], { strict: true })).join('\n')}\n${frontmatter[2]}`;
}

// Fenced code and Markdown table delimiter rows use hyphens as syntax. Unicode
// em dashes are still checked in the full authored skill copy below.
function skillProseWithoutDashSyntax(copy: string): string {
  return copy
    .replaceAll(/```[\s\S]*?```/g, '')
    .replaceAll(/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/gm, '');
}

function workflowRounds(parsed: Record<string, unknown>): string[] {
  const prompts = parsed.prompts as { readonly userRequest: string | string[] };
  return Array.isArray(prompts.userRequest)
    ? prompts.userRequest
    : [prompts.userRequest];
}

function typeScriptStrings(relativePath: string): string[] {
  const sourceFile = parseSourceFile(resolve(REPO_ROOT, relativePath));
  const strings: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      strings.push(node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return strings;
}

function templateMarkers(source: string): string[] {
  return [...source.matchAll(/{{[\s\S]*?}}|{%[\s\S]*?%}/g)]
    .map(([marker]) => marker.replaceAll(/\s+/g, ' ').trim())
    .sort();
}

const WORKFLOW_ROUNDS = {
  'packages/extension/resources/agents/correct.yaml': 1,
  'packages/extension/resources/agents/merge.yaml': 1,
  'packages/extension/resources/agents/ocr.yaml': 2,
  'packages/extension/resources/agents/polish.yaml': 2,
  'packages/extension/resources/agents/transcribe_audio.yaml': 2,
  'packages/extension/resources/agents/write/paper2poster.yaml': 2,
  'packages/extension/resources/agents/write/paper2slide.yaml': 2,
  'packages/extension/resources/templates/agentTemplate-workflowSingle.yaml': 2,
  'prompts/agents/remote/apply.yaml': 1,
  'prompts/agents/remote/criticize.yaml': 2,
  'prompts/agents/remote/devise.yaml': 2,
  'prompts/agents/remote/elevate.yaml': 2,
  'prompts/agents/remote/enhance.yaml': 2,
  'prompts/agents/remote/firstread.yaml': 2,
  'prompts/agents/remote/generic.yaml': 2,
  'prompts/agents/remote/humanize.yaml': 2,
  'prompts/agents/remote/logic.yaml': 2,
  'prompts/agents/remote/notation.yaml': 2,
  'prompts/agents/remote/verifyFix.yaml': 3,
} as const;

const FILE_ORDER_WORKFLOWS = [
  'packages/extension/resources/agents/polish.yaml',
  'prompts/agents/remote/apply.yaml',
  'prompts/agents/remote/criticize.yaml',
  'prompts/agents/remote/devise.yaml',
  'prompts/agents/remote/elevate.yaml',
  'prompts/agents/remote/enhance.yaml',
  'prompts/agents/remote/generic.yaml',
  'prompts/agents/remote/logic.yaml',
  'prompts/agents/remote/notation.yaml',
];

describe('built-in authored prompt inventory', () => {
  it.each(PROMPT_RESOURCE_FILES)('%s parses strictly', (file) => {
    expect(parsePromptYaml(file)).toBeTypeOf('object');
  });

  it.each(PROMPT_RESOURCE_FILES)(
    '%s has no em dash in authored fields',
    (file) => {
      expect(authoredYamlCopy(file)).not.toMatch(/\u2014|---/);
    },
  );

  it('inventories every shared injected prompt fragment', () => {
    expect(SHARED_PROMPT_FRAGMENT_FILES).toEqual(
      Object.keys(SHARED_PROMPT_FRAGMENTS),
    );
  });

  it.each(SHARED_PROMPT_FRAGMENT_FILES)(
    '%s has no em dash or stock model phrasing',
    (file) => {
      const copy = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(copy).not.toMatch(/\u2014|---/);
      expect(copy).not.toMatch(STOCK_MODEL_PHRASING);
    },
  );

  it.each(Object.entries(SHARED_PROMPT_FRAGMENTS))(
    '%s is loaded and injected through its declared token',
    (file, { token, loader }) => {
      const consumers = PROMPT_RESOURCE_FILES.filter((resource) =>
        readFileSync(resolve(REPO_ROOT, resource), 'utf8').includes(
          `{{ ${token} }}`,
        ),
      );
      const loaderSource = readFileSync(resolve(REPO_ROOT, loader), 'utf8');
      expect(readFileSync(resolve(REPO_ROOT, file), 'utf8')).not.toBe('');
      expect(loaderSource).toContain(file.split('/').at(-1));
      expect(loaderSource).toContain(`${token}:`);
      expect(consumers.length).toBeGreaterThan(0);
    },
  );

  it('covers every TypeScript model-copy source root and known external source', () => {
    for (const evidence of Object.values(
      TYPESCRIPT_MODEL_COPY_EXTERNAL_SOURCES,
    )) {
      expect(evidence).not.toBe('');
    }
    expect(TYPESCRIPT_MODEL_COPY_INVENTORY).toEqual(
      expect.arrayContaining([
        'src/agent/implementations/flows/tooluse/toolUseRound/ToolUseProcessNode.ts',
        'src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts',
        'src/agent/prompt/PromptBuilder.ts',
        'src/tools/ExecutionsTool.ts',
        'src/tools/registry.ts',
      ]),
    );
  });

  it('documents every intentional non-prompt dash exception', () => {
    for (const [file, exception] of Object.entries(
      INTENTIONAL_NON_PROMPT_DASH_LITERALS,
    )) {
      expect(TYPESCRIPT_MODEL_COPY_INVENTORY).toContain(file);
      expect(exception.evidence).not.toBe('');
      expect(exception.literals.length).toBeGreaterThan(0);
    }
  });

  it.each(BUILTIN_SKILL_SOURCE_FILES)(
    '%s has no prose em dash or stock model phrasing',
    (file) => {
      const copy = authoredSkillCopy(file);
      expect(copy).not.toMatch(/\u2014/);
      expect(skillProseWithoutDashSyntax(copy)).not.toMatch(/---/);
      expect(copy).not.toMatch(STOCK_MODEL_PHRASING);
    },
  );

  it.each(TYPESCRIPT_MODEL_COPY_INVENTORY)(
    '%s has no prose em dash or stock model phrasing in string literals',
    (file) => {
      const strings = typeScriptStrings(file);
      const dashLiterals = strings
        .filter((text) => /\u2014|---/.test(text))
        .sort();
      expect(dashLiterals).toEqual(
        [
          ...(INTENTIONAL_NON_PROMPT_DASH_LITERALS[file]?.literals ?? []),
        ].sort(),
      );
      expect(strings.join('\n')).not.toMatch(STOCK_MODEL_PHRASING);
    },
  );
});

describe('YAML prompt structure contracts', () => {
  const workflowFiles = PROMPT_RESOURCE_FILES.filter((file) => {
    const parsed = parsePromptYaml(file);
    const settings = parsed.settings as
      { readonly agentCategory?: string } | undefined;
    return settings?.agentCategory === 'workflow';
  });

  it('matches the placeholder and control snapshot', () => {
    const markerInventory = PROMPT_RESOURCE_FILES.filter(
      (file) => !LIQUID_AGENT_TEMPLATES.has(file),
    ).map((file) => [file, templateMarkers(authoredYamlCopy(file))]);
    const digest = createHash('sha256')
      .update(JSON.stringify(markerInventory))
      .digest('hex');
    expect(digest).toBe(
      '9ec149a7983e8791a7d50ddd715ca7dab9b2a697c07936c573d40ef0af809bdc',
    );
  });

  it.each(PROMPT_RESOURCE_FILES)('%s balances Liquid control tags', (file) => {
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    const controls = templateMarkers(source).filter((marker) =>
      marker.startsWith('{%'),
    );
    for (const [opening, closing] of [
      ['{% if ', '{% endif %}'],
      ['{% for ', '{% endfor %}'],
      ['{% raw %}', '{% endraw %}'],
    ]) {
      expect(controls.filter((tag) => tag.startsWith(opening))).toHaveLength(
        controls.filter((tag) => tag === closing).length,
      );
    }
  });

  it.each(workflowFiles)('%s keeps complete round envelopes', (file) => {
    const rounds = workflowRounds(parsePromptYaml(file));
    for (const round of rounds) {
      expect(round).toContain('<documents>');
      expect(round).toContain('</documents>');
      expect(round).toContain('<document name=');
      expect(round.match(/<documents>/g)?.length ?? 0).toBe(
        round.match(/<\/documents>/g)?.length ?? 0,
      );
    }
  });

  it('classifies every workflow round count', () => {
    expect(workflowFiles).toEqual(Object.keys(WORKFLOW_ROUNDS).sort());
  });

  it.each(Object.entries(WORKFLOW_ROUNDS))(
    '%s keeps its $expectedRounds rounds',
    (file, expectedRounds) => {
      const parsed = parsePromptYaml(file);
      expect(workflowRounds(parsed)).toHaveLength(expectedRounds);
      const settings = parsed.settings as { readonly rounds?: number };
      if (settings.rounds !== undefined) {
        expect(settings.rounds).toBe(expectedRounds);
      }
    },
  );

  it.each(Object.entries(WORKFLOW_ROUNDS).filter(([, rounds]) => rounds > 1))(
    '%s keeps required multi-round workflow markers',
    (file) => {
      const source = LIQUID_AGENT_TEMPLATES.has(file)
        ? readFileSync(resolve(REPO_ROOT, file), 'utf8')
        : authoredYamlCopy(file);
      const markers = templateMarkers(source);
      expect(markers).toContain('{{ ALL_INPUTS }}');
      expect(markers).toContain('{{ INSTRUCTION }}');
    },
  );

  it('classifies every final file-order expression', () => {
    const expression = "{{ INPUT_FILES | default([], true) | join(', ') }}";
    expect(
      workflowFiles
        .filter((file) => authoredYamlCopy(file).includes(expression))
        .sort(),
    ).toEqual(FILE_ORDER_WORKFLOWS.toSorted());
  });

  it.each(FILE_ORDER_WORKFLOWS)(
    '%s keeps the final file-order expression',
    (file) => {
      expect(workflowRounds(parsePromptYaml(file)).at(-1)).toContain(
        "{{ INPUT_FILES | default([], true) | join(', ') }}",
      );
    },
  );

  it('keeps tool-use skeleton markers', () => {
    const source = readFileSync(
      resolve(
        REPO_ROOT,
        'packages/extension/resources/templates/agentTemplate-toolUse.yaml',
      ),
      'utf8',
    );
    expect(templateMarkers(source)).toEqual(
      [
        '{{ AGENT_NAME }}',
        `{{ DESCRIPTION | replace("'", "''") }}`,
        '{{ DESCRIPTION }}',
        '{{ INSTRUCTION }}',
        '{{ TOOLS_YAML }}',
      ].sort(),
    );
  });

  it('keeps workflow skeleton branches and output markers', () => {
    const source = readFileSync(
      resolve(
        REPO_ROOT,
        'packages/extension/resources/templates/agentTemplate-workflowSingle.yaml',
      ),
      'utf8',
    );
    expect(templateMarkers(source)).toEqual(
      [
        '{{ AGENT_NAME }}',
        `{{ DESCRIPTION | replace("'", "''") }}`,
        '{{ DESCRIPTION }}',
        '{{ ALL_CONTEXTS }}',
        '{{ ALL_INPUTS }}',
        '{{ INSTRUCTION }}',
        '{{ output }}',
        '{{ output }}',
        '{% raw %}',
        '{% raw %}',
        '{% endraw %}',
        '{% endraw %}',
        '{% if INSTRUCTION %}',
        '{% endif %}',
        '{% for output in INPUT_FILES %}',
        '{% for output in INPUT_FILES %}',
        '{% endfor %}',
        '{% endfor %}',
      ].sort(),
    );
  });
});

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

describe('progress-check agent prompts', () => {
  const progressCheck = loadAgentYaml<ToolUseAgentYaml>(
    'prompts/agents/remote/progressCheck.yaml',
  );
  const { systemPrompt } = progressCheck.prompts;
  const orchestrator = loadAgentYaml<ToolUseAgentYaml>(
    'prompts/agents/remote/orchestrator.yaml',
  );
  const leanOrchestrator = loadAgentYaml<ToolUseAgentYaml>(
    'prompts/agents/remote/Lean4/leanOrchestrator.yaml',
  );

  it('keeps self-contained read-only reviews on the narrow evidence path', () => {
    expect(systemPrompt).toContain(
      'This narrow path takes precedence even when the session is part of a standing project goal.',
    );
    expect(systemPrompt).toContain(
      'On the narrow path, evaluate only signals stated in the named execution reports.',
    );
    expect(systemPrompt).toContain(
      'On the narrow path, evaluate only the named reports and explicitly named files.',
    );
    expect(systemPrompt).toContain(
      'Otherwise, continue with the broader checks below',
    );
    expect(systemPrompt).toContain(
      'Do not call `/executions/current`, list sibling executions, or inspect unnamed reports.',
    );
  });

  it('gives progressCheck the request and execution records from every orchestrator', () => {
    for (const agent of [orchestrator, leanOrchestrator]) {
      expect(agent.prompts.systemPrompt).toContain(
        'Include the latest user request and the relevant execution IDs in the delegated instruction.',
      );
    }
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

describe('numerics agent prompt', () => {
  const agent = loadAgentYaml<ToolUseAgentYaml>(
    'packages/extension/resources/tool_use_agents/numerics.yaml',
  );

  it('encodes mathematical properties as assertions or tests', () => {
    expect(agent.prompts.systemPrompt).toContain(
      'Encode mathematical properties such as conservation laws, symmetries, limiting cases, and convergence rates as assertions or tests.',
    );
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
