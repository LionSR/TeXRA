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
} from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { formatDuration } from '@utils/core';

// Local imports - formatter helpers
import {
  buildFileLinkSpan,
  buildStatusBadge,
  buildToolUseSection,
  wrapInPre,
  SPINNER_ICON_NAME,
  triStateStatusIcon,
} from '../htmlBuilders';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';

type RenderableSection = TemplateResult | typeof nothing | undefined | null;
type BadgeData = {
  iconName: TeXRAIconName | typeof SPINNER_ICON_NAME;
  label: string;
};
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
      (badge) => buildStatusBadge(badge.iconName, badge.label),
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
  const badges: BadgeData[] = [
    input.sandbox_mode
      ? { iconName: 'shield', label: input.sandbox_mode }
      : null,
    input.thread_id ? { iconName: 'comments', label: 'follow-up' } : null,
  ].filter((badge): badge is BadgeData => badge != null);

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
          iconName: triStateStatusIcon(patchStatus, null),
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
      ${waIcon('file')} ${buildFileLinkSpan(change.path, change.path)}
      <span class="file-source">(${change.kind})</span>
    </li>
  `;
}

function renderCodexFileListSection(
  changes: CodexFileChangeToolInput['changes'],
): RenderableSection {
  return when(changes.length > 0, () =>
    buildToolUseSection(
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
    ),
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
          iconName: 'list-check',
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
      ${waIcon(item.completed ? 'circle-check' : 'circle')}
      <span>${item.text}</span>
    </li>
  `;
}

function renderCodexTodoListSection(
  items: CodexTodoToolInput['items'],
): RenderableSection {
  return when(items.length > 0, () =>
    buildToolUseSection(
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
    ),
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

function renderCodexTurnStateSection(state: string): RenderableSection {
  return state
    ? renderBadgeSection('State:', [
        { iconName: triStateStatusIcon(state, 'running'), label: state },
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
