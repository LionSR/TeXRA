// Third-party imports
import { Array as Arr, Effect, FileSystem } from 'effect';

// Local imports - agent
import type { TemplateOpening } from '@agent/prompt/templateInputs';
import { delegationUpdate } from '@agent/runtime/delegation/delegationAvailability';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { PromptSections } from '@shared/schemas';
import type { SkillCatalogEntry } from '@skills/runtimeSkills';
import type { Plugin } from '@tools/plugins';
import type { PromptSection } from '@tools/toolTable';

// Local imports - utilities
import { renderPrompt } from '@agent/prompt/promptRender';
import { loadAgentsMd } from '@agent/prompt/agentsMd';
import type { MemoryFolder } from '@agent/memory/memoryLayout';
import { buildWorkspaceInfoBlock } from './workspaceInfo';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * Instructions appended to an agent-with-tools prompt at open, led by the
 * working-directory sentences of the tools its first step offers. What
 * depends on the model or the settings is rendered by each step
 * (`stepInstructions`).
 */
const toolUseInstructions = (offered: readonly string[], cwd: string) => {
  const offers = (...names: string[]) =>
    names.some((name) => offered.includes(name));
  const workingDirectory = [
    offers('bash') &&
      `Working directory: the bash tool already executes every command from ${cwd}. You are already in the workspace, so run commands directly with relative paths (e.g., \`ls src/\`, \`cat README.md\`).`,
    offers('bash', 'glob', 'grep') &&
      'Scope file searches to `.` or a subdirectory, or use the glob/grep tools.',
  ].filter(Boolean);
  const lead =
    workingDirectory.length > 0 ? `${workingDirectory.join(' ')}\n` : '';
  return `<tool_use_instructions>
${lead}Explicit user constraints override general workflow guidance elsewhere in the agent prompt. If the user forbids memory, planning, file access, or a tool, do not use it. Report any resulting conflict instead.

Prefer using tools over asking the user to take manual actions.
Do not ask for permission in chat before editing a file or running a command: when the user's approval settings require confirmation, the harness asks before the call runs.
If you say you will perform an action, immediately call the corresponding tool.
Do only what the task requires. Do not refactor, restructure, or "improve" material beyond it. When the user describes a problem without asking for a change, deliver your assessment before editing files.
When this run carries out an approved plan or a goal's round, work toward it end to end. Keep going and verify against real evidence rather than pausing to confirm each step or summarize progress. Stop only when it is verifiably done or you are genuinely blocked on something only the user can provide.
In replies, lead with the outcome. Keep responses short by being selective about what to include, not by compressing the writing.
Never mention tool names when speaking to the user.
</tool_use_instructions>`;
};

/** How a step that offers tools may issue its calls, and, when one of them
 *  creates files, which files not to create. */
const toolCalls = (offered: readonly string[]) =>
  [
    'Independent tool calls may be issued together in one response. Sequence only calls that depend on an earlier result.',
    ...(['write_file', 'bash'].some((name) => offered.includes(name))
      ? [
          'Do not create excessive markdown files or documentation unless explicitly requested.',
        ]
      : []),
  ].join('\n');

/**
 * The context a step renders: the tools it offers and the sections it adds
 * after the run's recorded prompt, by name, in order: how to issue tool
 * calls, the skills the step lists, its memory, then each pinned plugin's
 * section, in plugin id order. They are built from the step (its settings, offered tools
 * and pinned contributors) and the skill catalog it discovers, so a setting
 * change reaches the next request, and a resume rebuilds them.
 */
export function stepInstructions(
  plugins: readonly Pick<Plugin, 'id' | 'prompt'>[],
  skills: readonly SkillCatalogEntry[],
  memory: string | null,
  ctx: Parameters<PromptSection>[0],
): PromptSections {
  const sections = Object.fromEntries([
    // A step that offers no tool (a document reviser, the critic) has no
    // calls to make.
    ...(ctx.offered.length > 0 ? [['tool-call', toolCalls(ctx.offered)]] : []),
    ...(skills.length > 0
      ? [
          [
            'skills',
            `<available_skills>\nThe following skills are available. If one is relevant, inspect its SKILL.md at the listed path before applying it; a skill's relative links resolve against its own directory.\n${skills.map(({ text }) => text).join('\n')}\n</available_skills>`,
          ],
        ]
      : []),
    ...(memory === null ? [] : [['memory', memory]]),
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
export function contextUpdate(
  told: PromptSections,
  now: PromptSections,
): string {
  const lines = Object.entries(now.sections).flatMap(([name, text]) =>
    told.sections[name] === text ? [] : [text],
  );
  for (const name of Object.keys(told.sections))
    if (!Object.hasOwn(now.sections, name))
      lines.push(`The earlier ${name} instructions no longer apply.`);
  const added = Arr.difference(now.tools, told.tools);
  const removed = Arr.difference(told.tools, now.tools);
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
 * The system text a conversation opens with: its run's own system text
 * rendered, then the user's and project's `AGENTS.md`, and the suffix of
 * tool-use instructions and workspace facts, which a text-only run (one that
 * declares no tools) goes without. Only the run's own system text is a
 * template: the suffix is text this module builds, and the workspace facts in
 * it (a path, a branch name) come from the project, so they are data and are
 * never rendered. What each step's plugins add is appended per request
 * (`stepInstructions`).
 */
export const buildOpeningSystemPrompt = Effect.fn('prompt.openingSystem')(
  function* (
    system: string,
    { inputs }: TemplateOpening,
    options: {
      /** The run's session roots: the workspace whose `AGENTS.md` and
       *  `<workspace_info>` it reads, the storage root whose `AGENTS.md`
       *  is the person's own, and the setting slots the `<workspace_info>`
       *  git reads take. */
      roots: WorkspaceRoots;
      /** A run that declares no tools: no tool-use suffix. */
      textOnly: boolean;
      /** The tools the run's first step offers, by name: the suffix names
       *  only those. */
      offered: readonly string[];
      /** The memory folders that step reads and writes, none for a run
       *  with no memory: `<workspace_info>` says where they are. */
      memory: readonly MemoryFolder[];
    },
  ): Effect.fn.Return<
    string,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  > {
    const rendered = yield* renderPrompt(system, inputs);
    const { roots } = options;
    // The two workspace reads are independent; run them together.
    const [agentsMd, workspaceInfo] = yield* Effect.all(
      [
        loadAgentsMd(roots.workspace, roots.storageRoot),
        options.textOnly
          ? Effect.succeed('')
          : buildWorkspaceInfoBlock(
              roots.workspace,
              options.offered,
              options.memory,
            ),
      ],
      { concurrency: 'unbounded' },
    );
    const systemPrompt = [rendered, agentsMd].filter(Boolean).join('\n');
    if (options.textOnly) return systemPrompt;
    return [
      systemPrompt,
      toolUseInstructions(options.offered, inputs.CWD),
      workspaceInfo,
    ]
      .filter(Boolean)
      .join('\n');
  },
);
