// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - agent
import type { TemplateVars } from '@agent/prompt/templateInputs';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { RunContext, SkillCatalogEntry } from '@shared/schemas';
import { delegationUpdate } from '@tools/delegation/delegationAvailability';
import type { Plugin } from '@tools/plugins';
import type { PromptSection } from '@tools/toolTable';

// Local imports - utilities
import { renderPrompt } from '@utils/prompt';
import { loadAgentsMd } from '@utils/files/agentsMd';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * Instructions appended to tool-use agent prompts at open. What depends on
 * the model or the settings is rendered by each step (`stepInstructions`).
 */
const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
Working directory: the bash tool already executes every command from {{ CWD }}. You are already in the workspace, so run commands directly with relative paths (e.g., \`ls src/\`, \`find . -name "*.tex"\`, \`cat README.md\`). Scope file searches to \`.\` or a subdirectory, or use the glob/grep tools.
Explicit user constraints override general workflow guidance elsewhere in the agent prompt. If the user forbids memory, planning, file access, or a tool, do not use it. Report any resulting conflict instead.

Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
Do only what the task requires. Do not refactor, restructure, or "improve" material beyond it. When the user describes a problem without asking for a change, deliver your assessment before editing files.
When an approved plan or autonomous objective is active, work toward it end to end. Keep going and verify against real evidence rather than pausing to confirm each step or summarize progress. Stop only when it is verifiably done or you are genuinely blocked on something only the user can provide.
In replies, lead with the outcome. Keep responses short by being selective about what to include, not by compressing the writing.
Never mention tool names when speaking to the user.
For math in responses, use $...$ or \\(...\\) for inline and $$...$$ or \\[...\\] for display math. Wrap LaTeX environments like align or gather inside $$...$$ (e.g., $$\\begin{align}...\\end{align}$$) so they render correctly.
</tool_use_instructions>`;

/**
 * The tool-call mechanics are provider-gated: OpenAI-compatible providers
 * (DeepSeek, Kimi, GLM, MiniMax, …) need the schema/JSON/multi_tool_use
 * guardrails and the sequential-call constraint (Google/DeepSeek thought-
 * signature batching assumes ordered follow-ups). Anthropic models handle
 * parallel tool calls natively, so they get the parallel encouragement
 * instead of the weak-model boilerplate.
 */
const ANTHROPIC_TOOL_CALLS = `Independent tool calls may be issued together in one response. Sequence only calls that depend on an earlier result.
Do not create excessive markdown files or documentation unless explicitly requested.`;
const SEQUENTIAL_TOOL_CALLS = `When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Do not call tools that are not provided or any multi_tool_use variants.
Call tools sequentially and wait for the output before calling another.`;

/**
 * The context a step renders: the tools it offers and the sections it adds
 * after the run's recorded prompt, by name, in order: the tool-call
 * mechanics of the step's model, the skills the step lists, then each pinned plugin's
 * section, in plugin id order. They are built from the step (its model,
 * settings, offered tools and pinned contributors) and the skill catalog it
 * discovers, so a model switch or a setting change reaches the next request,
 * and a resume rebuilds them.
 */
export function stepInstructions(
  plugins: readonly Pick<Plugin, 'id' | 'prompt'>[],
  skills: readonly SkillCatalogEntry[],
  ctx: Parameters<PromptSection>[0],
): RunContext {
  const sections = Object.fromEntries([
    [
      'tool-call',
      ctx.isAnthropic ? ANTHROPIC_TOOL_CALLS : SEQUENTIAL_TOOL_CALLS,
    ],
    ...(skills.length > 0
      ? [
          [
            'skills',
            `<available_skills>\nThe following imported skills are available. If one is relevant, inspect its SKILL.md at the listed path before applying it.\n${skills.map(({ text }) => text).join('\n')}\n</available_skills>`,
          ],
        ]
      : []),
    ...plugins.flatMap(({ id, prompt }) => {
      const text = prompt?.(ctx);
      return text ? [[`${id} plugin`, text]] : [];
    }),
  ]);
  return { sections, tools: [...ctx.offered] };
}

/** What changed from the context the model was told to `now`, as the text
 *  of the system message that tells it: each section added or reworded,
 *  each one withdrawn, the tools that came and went, and the delegation
 *  targets that did. '' for none. */
export function contextUpdate(told: RunContext, now: RunContext): string {
  const lines = Object.entries(now.sections).flatMap(([name, text]) =>
    told.sections[name] === text ? [] : [text],
  );
  for (const name of Object.keys(told.sections))
    if (!Object.hasOwn(now.sections, name))
      lines.push(`The earlier ${name} instructions no longer apply.`);
  const added = now.tools.filter((name) => !told.tools.includes(name));
  const removed = told.tools.filter((name) => !now.tools.includes(name));
  if (added.length > 0)
    lines.push(`These tools are now available: ${added.join(', ')}.`);
  if (removed.length > 0)
    lines.push(
      `These tools are no longer available; do not call them: ${removed.join(', ')}.`,
    );
  if (now.delegation)
    lines.push(...delegationUpdate(told.delegation, now.delegation));
  return lines.join('\n');
}

/**
 * Combine the base system prompt with the project's `AGENTS.md`, if any.
 *
 * @param systemPrompt Base system prompt template
 * @param userVars Variables for template rendering
 * @param workspace The run's workspace root, whose `AGENTS.md` applies
 * @returns Full system prompt string
 */
export const getSystemPromptWithRules = Effect.fn('prompt.systemWithRules')(
  function* (
    systemPrompt: string,
    userVars: TemplateVars,
    workspace: string | undefined,
  ): Effect.fn.Return<string, Error, FileSystem.FileSystem> {
    const parts = [yield* renderPrompt(systemPrompt, userVars)];

    const instructions = yield* loadAgentsMd(workspace);
    if (instructions) parts.push(instructions);

    // Append attached memories (read-only context from orchestrator)
    const attachedMemories = userVars.ATTACHED_MEMORIES;
    if (typeof attachedMemories === 'string' && attachedMemories) {
      parts.push(attachedMemories);
    }

    return parts.join('\n');
  },
);

/**
 * The system text a conversation opens with: its persona's prompt rendered
 * with the project's rules (`getSystemPromptWithRules`), and the suffix of
 * tool-use instructions and workspace facts. What each step's plugins add is
 * appended per request (`stepInstructions`).
 */
export const buildInitialToolUsePrompts = Effect.fn('prompt.initialToolUse')(
  function* (
    personaPrompt: string,
    userVars: TemplateVars,
    options: {
      /** The run's workspace root: its `AGENTS.md` and `<workspace_info>`. */
      workspace: string | undefined;
      /** The same session's setting slots, for the `<workspace_info>` git reads. */
      settings: SettingsStores;
    },
  ): Effect.fn.Return<
    { readonly systemPrompt: string; readonly instructionSuffix: string },
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  > {
    const systemPrompt = yield* getSystemPromptWithRules(
      personaPrompt,
      userVars,
      options.workspace,
    );
    const suffixParts = [
      TOOL_USE_INSTRUCTIONS,
      yield* buildWorkspaceInfoBlock(options.workspace, options.settings),
    ];
    return {
      systemPrompt,
      instructionSuffix: yield* renderPrompt(suffixParts.join('\n'), userVars),
    };
  },
);
