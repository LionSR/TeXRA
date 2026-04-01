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
import { html, type TemplateResult } from '../litTemplates';

// Local imports - formatter helpers
import { buildToolUseSection, wrapInPre } from '../htmlBuilders';
import { formatTokens } from '../timestampUtils';

type CodexRenderableToolName =
  | 'codex'
  | typeof CODEX_FILE_CHANGE_TOOL
  | typeof CODEX_THREAD_TOOL
  | typeof CODEX_TODO_TOOL
  | typeof CODEX_TURN_TOOL;

function compactSections(
  sections: Array<TemplateResult | null>,
): TemplateResult[] {
  return sections.filter(
    (section): section is TemplateResult => section !== null,
  );
}

function renderBadge(iconClass: string, label: string): TemplateResult {
  // prettier-ignore
  return html`<span class="extract-flag"><i class="codicon ${iconClass}"></i> ${label}</span>`;
}

function renderBadgeSection(
  label: string,
  badges: Array<{ iconClass: string; label: string }>,
): TemplateResult | null {
  if (badges.length === 0) {
    return null;
  }

  return buildToolUseSection(
    label,
    html`${badges.map((badge) => renderBadge(badge.iconClass, badge.label))}`,
  );
}

function renderCodexPromptSection(input: CodexInput): TemplateResult | null {
  return input.prompt
    ? buildToolUseSection('Prompt:', wrapInPre(input.prompt))
    : null;
}

function renderCodexModeSection(input: CodexInput): TemplateResult | null {
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

function renderCodexDirectorySection(input: CodexInput): TemplateResult | null {
  return input.working_directory
    ? buildToolUseSection('Directory:', wrapInPre(input.working_directory))
    : null;
}

function renderCodexInputSections(input: unknown): TemplateResult[] | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const codexInput = input as CodexInput;
  return compactSections([
    renderCodexPromptSection(codexInput),
    renderCodexModeSection(codexInput),
    renderCodexDirectorySection(codexInput),
  ]);
}

function renderCodexFileStatusSection(
  patchStatus: string,
): TemplateResult | null {
  return patchStatus
    ? renderBadgeSection('Status:', [
        {
          iconClass:
            patchStatus === 'failed' ? 'codicon-error' : 'codicon-check',
          label: patchStatus,
        },
      ])
    : null;
}

function renderCodexFileListSection(
  changes: CodexFileChange[],
): TemplateResult | null {
  if (changes.length === 0) {
    return null;
  }

  // prettier-ignore
  return buildToolUseSection('Files:', html`<ul class="detail-list">${changes.map((change) => html`<li class="detail-item"><i class="codicon codicon-file"></i> <span class="file-link clickable-link" data-file=${change.path}>${change.path}</span> <span class="file-source">(${change.kind})</span></li>`)}</ul>`);
}

function renderCodexFileChangeSections(
  input: unknown,
): TemplateResult[] | null {
  if (!isPlainObject(input)) {
    return null;
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

  return compactSections([
    renderCodexFileStatusSection(patchStatus),
    renderCodexFileListSection(changes),
  ]);
}

function renderCodexThreadSections(input: unknown): TemplateResult[] | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const threadInput = input as Partial<CodexThreadToolInput>;
  return compactSections([
    typeof threadInput.threadId === 'string' && threadInput.threadId
      ? // prettier-ignore
        buildToolUseSection('Thread ID:', html`<code class="execution-id">${threadInput.threadId}</code>`)
      : null,
  ]);
}

function renderCodexTodoProgressSection(
  completedCount: number,
  totalCount: number,
): TemplateResult | null {
  return totalCount > 0
    ? renderBadgeSection('Progress:', [
        {
          iconClass: 'codicon-checklist',
          label: `${completedCount}/${totalCount} completed`,
        },
      ])
    : null;
}

function renderCodexTodoListSection(
  items: Array<{ text: string; completed: boolean }>,
): TemplateResult | null {
  if (items.length === 0) {
    return null;
  }

  // prettier-ignore
  return buildToolUseSection('Checklist:', html`<ul class="detail-list">${items.map((item) => html`<li class="detail-item"><i class="codicon ${item.completed ? 'codicon-pass-filled' : 'codicon-circle-large-outline'}"></i> <span>${item.text}</span></li>`)}</ul>`);
}

function renderCodexTodoSections(input: unknown): TemplateResult[] | null {
  if (!isPlainObject(input)) {
    return null;
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

  return compactSections([
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

function renderCodexTurnStateSection(state: string): TemplateResult | null {
  return state
    ? renderBadgeSection('State:', [
        { iconClass: getCodexTurnStateIcon(state), label: state },
      ])
    : null;
}

function renderCodexTurnDurationSection(
  wallTimeMs: number,
): TemplateResult | null {
  return wallTimeMs > 0
    ? buildToolUseSection('Duration:', wrapInPre(formatDuration(wallTimeMs)))
    : null;
}

function renderCodexTurnUsageSection(
  turnInput: Partial<CodexTurnToolInput>,
): TemplateResult | null {
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

function renderCodexTurnSections(input: unknown): TemplateResult[] | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const turnInput = input as Partial<CodexTurnToolInput>;
  const state = typeof turnInput.state === 'string' ? turnInput.state : '';
  const wallTimeMs =
    typeof turnInput.wallTimeMs === 'number' ? turnInput.wallTimeMs : 0;

  return compactSections([
    renderCodexTurnStateSection(state),
    renderCodexTurnDurationSection(wallTimeMs),
    renderCodexTurnUsageSection(turnInput),
  ]);
}

export function renderCodexToolSections(
  toolName: string,
  input: unknown,
): TemplateResult[] | null {
  switch (toolName as CodexRenderableToolName) {
    case 'codex':
      return renderCodexInputSections(input);
    case CODEX_FILE_CHANGE_TOOL:
      return renderCodexFileChangeSections(input);
    case CODEX_THREAD_TOOL:
      return renderCodexThreadSections(input);
    case CODEX_TODO_TOOL:
      return renderCodexTodoSections(input);
    case CODEX_TURN_TOOL:
      return renderCodexTurnSections(input);
    default:
      return null;
  }
}
