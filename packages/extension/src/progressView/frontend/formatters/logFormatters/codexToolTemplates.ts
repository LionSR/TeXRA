// Third-party imports
import { z } from 'zod';

// Local imports - shared utilities
import {
  CODEX_FILE_CHANGE_TOOL,
  CODEX_THREAD_TOOL,
  CODEX_TODO_TOOL,
  CODEX_TURN_TOOL,
  CodexFileChangeToolInputSchema,
  CodexThreadToolInputSchema,
  CodexTodoToolInputSchema,
  CodexTurnToolInputSchema,
} from '@tools/codexShared';
import { formatDuration } from '@utils/core';

// Local imports - Lit template utilities
import {
  html,
  nothing,
  repeat,
  when,
  type TemplateResult,
} from '../litTemplates';

// Local imports - formatter helpers
import { buildToolUseSection, wrapInPre } from '../htmlBuilders';

type RenderableSection = TemplateResult | typeof nothing | undefined | null;
type BadgeData = { iconClass: string; label: string };
type CodexToolRenderer = (input: unknown) => TemplateResult | typeof nothing;

/** Lenient schema for parsing codex tool input in the renderer. */
const CodexInputDisplaySchema = z.object({
  prompt: z.string().optional().default(''),
  sandbox_mode: z.string().optional(),
  thread_id: z.string().optional(),
});

type CodexInputDisplay = z.infer<typeof CodexInputDisplaySchema>;
type CodexFileChangeToolInput = z.infer<typeof CodexFileChangeToolInputSchema>;
type CodexTodoToolInput = z.infer<typeof CodexTodoToolInputSchema>;

function renderBadge({ iconClass, label }: BadgeData): TemplateResult {
  // prettier-ignore
  return html`<span class="extract-flag"><i class="codicon ${iconClass}"></i> ${label}</span>`;
}

function renderBadgeSection(
  label: string,
  badges: BadgeData[],
): RenderableSection {
  if (badges.length === 0) {
    return nothing;
  }

  return buildToolUseSection(
    label,
    html`${repeat(
      badges,
      (badge) => `${badge.iconClass}:${badge.label}`,
      renderBadge,
    )}`,
  );
}

function renderSectionGroup(
  sections: readonly RenderableSection[],
): TemplateResult | typeof nothing {
  const visibleSections = sections.filter(
    (section): section is TemplateResult =>
      section !== nothing && section != null,
  );
  if (visibleSections.length === 0) {
    return nothing;
  }

  return html`${repeat(
    visibleSections,
    (_section, index) => index,
    (section, index) =>
      html`${when(
        index > 0,
        () => html`<hr class="tool-use-separator" />`,
      )}${section}`,
  )}`;
}

function renderCodexPromptSection(input: CodexInputDisplay): RenderableSection {
  return when(Boolean(input.prompt), () =>
    buildToolUseSection('Prompt:', wrapInPre(input.prompt)),
  );
}

function renderCodexModeSection(input: CodexInputDisplay): RenderableSection {
  const badges = [
    ...(input.sandbox_mode
      ? [{ iconClass: 'codicon-shield', label: input.sandbox_mode }]
      : []),
    ...(input.thread_id
      ? [{ iconClass: 'codicon-comment-discussion', label: 'follow-up' }]
      : []),
  ];

  return renderBadgeSection('Mode:', badges);
}

function renderCodexInputContent(
  input: unknown,
): TemplateResult | typeof nothing {
  const parsed = CodexInputDisplaySchema.safeParse(input);
  if (!parsed.success) return nothing;

  return renderSectionGroup([
    renderCodexPromptSection(parsed.data),
    renderCodexModeSection(parsed.data),
  ]);
}

function renderCodexFileStatusSection(patchStatus: string): RenderableSection {
  return patchStatus
    ? renderBadgeSection('Status:', [
        {
          iconClass:
            patchStatus === 'failed' ? 'codicon-error' : 'codicon-check',
          label: patchStatus,
        },
      ])
    : nothing;
}

function renderCodexFileChangeItem(
  change: CodexFileChangeToolInput['changes'][number],
): TemplateResult {
  return html`
    <li class="detail-item">
      <i class="codicon codicon-file"></i>
      <span class="file-link clickable-link" data-file=${change.path}
        >${change.path}</span
      >
      <span class="file-source">(${change.kind})</span>
    </li>
  `;
}

function renderCodexFileListSection(
  changes: CodexFileChangeToolInput['changes'],
): RenderableSection {
  return when(
    changes.length > 0,
    () => html`
      ${buildToolUseSection(
        'Files:',
        html`
          <ul class="detail-list">
            ${repeat(
              changes,
              (change) => `${change.kind}:${change.path}`,
              renderCodexFileChangeItem,
            )}
          </ul>
        `,
      )}
    `,
  );
}

function renderCodexFileChangeContent(
  input: unknown,
): TemplateResult | typeof nothing {
  const parsed = CodexFileChangeToolInputSchema.safeParse(input);
  if (!parsed.success) return nothing;

  return renderSectionGroup([
    renderCodexFileStatusSection(parsed.data.patchStatus ?? ''),
    renderCodexFileListSection(parsed.data.changes),
  ]);
}

function renderCodexThreadContent(
  input: unknown,
): TemplateResult | typeof nothing {
  const parsed = CodexThreadToolInputSchema.safeParse(input);
  if (!parsed.success) return nothing;

  return renderSectionGroup([
    when(parsed.data.threadId.length > 0, () =>
      buildToolUseSection(
        'Thread ID:',
        html`<code class="execution-id">${parsed.data.threadId}</code>`,
      ),
    ),
  ]);
}

function renderCodexTodoProgressSection(
  completedCount: number,
  totalCount: number,
): RenderableSection {
  return totalCount > 0
    ? renderBadgeSection('Progress:', [
        {
          iconClass: 'codicon-checklist',
          label: `${completedCount}/${totalCount} completed`,
        },
      ])
    : nothing;
}

function renderCodexTodoItem(item: {
  text: string;
  completed: boolean;
}): TemplateResult {
  return html`
    <li class="detail-item">
      <i
        class="codicon ${item.completed
          ? 'codicon-pass-filled'
          : 'codicon-circle-large-outline'}"
      ></i>
      <span>${item.text}</span>
    </li>
  `;
}

function renderCodexTodoListSection(
  items: CodexTodoToolInput['items'],
): RenderableSection {
  return when(
    items.length > 0,
    () => html`
      ${buildToolUseSection(
        'Checklist:',
        html`
          <ul class="detail-list">
            ${repeat(
              items,
              (item, index) => `${index}:${item.text}:${item.completed}`,
              renderCodexTodoItem,
            )}
          </ul>
        `,
      )}
    `,
  );
}

function renderCodexTodoContent(
  input: unknown,
): TemplateResult | typeof nothing {
  const parsed = CodexTodoToolInputSchema.safeParse(input);
  if (!parsed.success) return nothing;

  return renderSectionGroup([
    renderCodexTodoProgressSection(
      parsed.data.completedCount,
      parsed.data.totalCount,
    ),
    renderCodexTodoListSection(parsed.data.items),
  ]);
}

function getCodexTurnStateIcon(state: string): string {
  return state === 'failed'
    ? 'codicon-error'
    : state === 'running'
      ? 'codicon-sync spin'
      : 'codicon-check';
}

function renderCodexTurnStateSection(state: string): RenderableSection {
  return state
    ? renderBadgeSection('State:', [
        { iconClass: getCodexTurnStateIcon(state), label: state },
      ])
    : nothing;
}

function renderCodexTurnDurationSection(wallTimeMs: number): RenderableSection {
  return wallTimeMs > 0
    ? buildToolUseSection('Duration:', wrapInPre(formatDuration(wallTimeMs)))
    : nothing;
}

function renderCodexTurnContent(
  input: unknown,
): TemplateResult | typeof nothing {
  const parsed = CodexTurnToolInputSchema.safeParse(input);
  if (!parsed.success) return nothing;

  return renderSectionGroup([
    renderCodexTurnStateSection(parsed.data.state),
    renderCodexTurnDurationSection(parsed.data.wallTimeMs ?? 0),
  ]);
}

export const codexToolRenderers = {
  codex: renderCodexInputContent,
  [CODEX_FILE_CHANGE_TOOL]: renderCodexFileChangeContent,
  [CODEX_THREAD_TOOL]: renderCodexThreadContent,
  [CODEX_TODO_TOOL]: renderCodexTodoContent,
  [CODEX_TURN_TOOL]: renderCodexTurnContent,
} satisfies Record<string, CodexToolRenderer>;
