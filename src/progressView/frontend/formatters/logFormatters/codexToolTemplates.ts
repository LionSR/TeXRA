// Local imports - shared utilities
import { isPlainObject } from '@shared/utils/string';
import type { CodexInput } from '@tools/codex';
import {
  CODEX_FILE_CHANGE_TOOL,
  CODEX_THREAD_TOOL,
  CODEX_TODO_TOOL,
  CODEX_TURN_TOOL,
  type CodexFileChange,
  type CodexFileChangeToolInput,
  type CodexThreadToolInput,
  type CodexTodoToolInput,
  type CodexTurnToolInput,
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
import { formatTokens } from '../timestampUtils';

type RenderableSection = TemplateResult | typeof nothing;
type BadgeData = { iconClass: string; label: string };
type CodexToolRenderer = (input: unknown) => RenderableSection;

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
): RenderableSection {
  const visibleSections = sections.filter(
    (section): section is TemplateResult => section !== nothing,
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

function renderCodexPromptSection(input: CodexInput): RenderableSection {
  return when(Boolean(input.prompt), () =>
    buildToolUseSection('Prompt:', wrapInPre(input.prompt)),
  );
}

function renderCodexModeSection(input: CodexInput): RenderableSection {
  const badges = [
    ...(input.sandbox_mode
      ? [{ iconClass: 'codicon-shield', label: input.sandbox_mode }]
      : []),
    ...(input.run_in_background
      ? [{ iconClass: 'codicon-run-all', label: 'background' }]
      : []),
  ];

  return renderBadgeSection('Mode:', badges);
}

function renderCodexDirectorySection(input: CodexInput): RenderableSection {
  const workingDirectory = input.working_directory ?? '';
  return when(workingDirectory.length > 0, () =>
    buildToolUseSection('Directory:', wrapInPre(workingDirectory)),
  );
}

function renderCodexInputContent(input: unknown): RenderableSection {
  if (!isPlainObject(input)) {
    return nothing;
  }

  const codexInput = input as CodexInput;
  return renderSectionGroup([
    renderCodexPromptSection(codexInput),
    renderCodexModeSection(codexInput),
    renderCodexDirectorySection(codexInput),
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

function renderCodexFileChangeItem(change: CodexFileChange): TemplateResult {
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
  changes: CodexFileChange[],
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

function renderCodexFileChangeContent(input: unknown): RenderableSection {
  if (!isPlainObject(input)) {
    return nothing;
  }

  const patchInput = input as Partial<CodexFileChangeToolInput>;
  const changes = Array.isArray(patchInput.changes)
    ? patchInput.changes.filter(
        (change): change is CodexFileChange =>
          typeof change?.path === 'string' && typeof change?.kind === 'string',
      )
    : [];
  const patchStatus =
    typeof patchInput.patchStatus === 'string' ? patchInput.patchStatus : '';

  return renderSectionGroup([
    renderCodexFileStatusSection(patchStatus),
    renderCodexFileListSection(changes),
  ]);
}

function renderCodexThreadContent(input: unknown): RenderableSection {
  if (!isPlainObject(input)) {
    return nothing;
  }

  const threadInput = input as Partial<CodexThreadToolInput>;
  return renderSectionGroup([
    when(
      typeof threadInput.threadId === 'string' &&
        threadInput.threadId.length > 0,
      () =>
        buildToolUseSection(
          'Thread ID:',
          html`<code class="execution-id">${threadInput.threadId}</code>`,
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
  items: Array<{ text: string; completed: boolean }>,
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

function renderCodexTodoContent(input: unknown): RenderableSection {
  if (!isPlainObject(input)) {
    return nothing;
  }

  const todoInput = input as Partial<CodexTodoToolInput>;
  const totalCount =
    typeof todoInput.totalCount === 'number' ? todoInput.totalCount : 0;
  const completedCount =
    typeof todoInput.completedCount === 'number' ? todoInput.completedCount : 0;
  const items = Array.isArray(todoInput.items)
    ? todoInput.items.filter(
        (item): item is { text: string; completed: boolean } =>
          typeof item?.text === 'string' &&
          typeof item?.completed === 'boolean',
      )
    : [];

  return renderSectionGroup([
    renderCodexTodoProgressSection(completedCount, totalCount),
    renderCodexTodoListSection(items),
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

function renderCodexTurnUsageSection(
  turnInput: Partial<CodexTurnToolInput>,
): RenderableSection {
  const badges = [
    ...(typeof turnInput.inputTokens === 'number'
      ? [
          {
            iconClass: 'codicon-arrow-up',
            label: `${formatTokens(turnInput.inputTokens)} in`,
          },
        ]
      : []),
    ...(typeof turnInput.outputTokens === 'number'
      ? [
          {
            iconClass: 'codicon-arrow-down',
            label: `${formatTokens(turnInput.outputTokens)} out`,
          },
        ]
      : []),
    ...(typeof turnInput.cachedInputTokens === 'number' &&
    turnInput.cachedInputTokens > 0
      ? [
          {
            iconClass: 'codicon-history',
            label: `${formatTokens(turnInput.cachedInputTokens)} cached`,
          },
        ]
      : []),
  ];

  return renderBadgeSection('Usage:', badges);
}

function renderCodexTurnContent(input: unknown): RenderableSection {
  if (!isPlainObject(input)) {
    return nothing;
  }

  const turnInput = input as Partial<CodexTurnToolInput>;
  const state = typeof turnInput.state === 'string' ? turnInput.state : '';
  const wallTimeMs =
    typeof turnInput.wallTimeMs === 'number' ? turnInput.wallTimeMs : 0;

  return renderSectionGroup([
    renderCodexTurnStateSection(state),
    renderCodexTurnDurationSection(wallTimeMs),
    renderCodexTurnUsageSection(turnInput),
  ]);
}

export const codexToolRenderers = {
  codex: renderCodexInputContent,
  [CODEX_FILE_CHANGE_TOOL]: renderCodexFileChangeContent,
  [CODEX_THREAD_TOOL]: renderCodexThreadContent,
  [CODEX_TODO_TOOL]: renderCodexTodoContent,
  [CODEX_TURN_TOOL]: renderCodexTurnContent,
} satisfies Record<string, CodexToolRenderer>;
