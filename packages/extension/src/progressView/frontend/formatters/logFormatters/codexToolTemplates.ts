// Third-party imports
import { z } from 'zod';
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

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
} from '@shared/schemas/codex';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { formatDuration } from '@utils/core';

// Local imports - formatter helpers
import {
  buildToolUseSection,
  wrapInPre,
  SPINNER_ICON_NAME,
} from '../htmlBuilders';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';

type RenderableSection = TemplateResult | typeof nothing | undefined | null;
type BadgeData = { iconName: string; label: string };
type CodexToolRenderer = (input: unknown) => TemplateResult | typeof nothing;

/** Lenient schema for parsing codex tool input in the renderer. */
const CodexInputDisplaySchema = z.object({
  prompt: z.string().default(''),
  sandbox_mode: z.string().optional(),
  thread_id: z.string().optional(),
});

type CodexInputDisplay = z.infer<typeof CodexInputDisplaySchema>;
type CodexFileChangeToolInput = z.infer<typeof CodexFileChangeToolInputSchema>;
type CodexTodoToolInput = z.infer<typeof CodexTodoToolInputSchema>;

function renderBadge({ iconName, label }: BadgeData): TemplateResult {
  // prettier-ignore
  const iconTemplate = iconName === SPINNER_ICON_NAME
    ? html`<wa-spinner></wa-spinner>`
    : html`<wa-icon library=${TEXRA_ICON_LIBRARY} name=${iconName} aria-hidden="true"></wa-icon>`;
  // prettier-ignore
  return html`<wa-badge variant="neutral" appearance="filled">${iconTemplate} ${label}</wa-badge>`;
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
      (badge) => `${badge.iconName}:${badge.label}`,
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
      html`${when(index > 0, () => html`<wa-divider></wa-divider>`)}${section}`,
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
      ? [{ iconName: 'shield', label: input.sandbox_mode }]
      : []),
    ...(input.thread_id
      ? [{ iconName: 'comment-discussion', label: 'follow-up' }]
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
          iconName: patchStatus === 'failed' ? 'error' : 'check',
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
      <wa-icon
        library=${TEXRA_ICON_LIBRARY}
        name="file"
        aria-hidden="true"
      ></wa-icon>
      <span
        class="file-link clickable-link"
        data-file=${change.path}
        role="button"
        tabindex="0"
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
          iconName: 'checklist',
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
      <wa-icon
        library=${TEXRA_ICON_LIBRARY}
        name=${item.completed ? 'pass-filled' : 'circle-large-outline'}
        aria-hidden="true"
      ></wa-icon>
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
  switch (state) {
    case 'failed':
      return 'error';
    case 'running':
      return SPINNER_ICON_NAME;
    default:
      return 'check';
  }
}

function renderCodexTurnStateSection(state: string): RenderableSection {
  return state
    ? renderBadgeSection('State:', [
        { iconName: getCodexTurnStateIcon(state), label: state },
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
