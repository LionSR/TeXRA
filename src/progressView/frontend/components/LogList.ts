// Third-party imports
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ref, createRef, type Ref } from 'lit/directives/ref.js';

// Local imports
import type { LogMessageData, TaskGroup } from '@shared/schemas';
import { getSharedLogEntryFormatter } from '../formatters';
import { formatTimestamp, formatDuration } from '../formatters';

@customElement('log-list')
export class LogList extends LitElement {
  @property({ type: Array }) logs: LogMessageData[] = [];
  @property({ type: Object }) groups: Record<string, TaskGroup> = {};
  @property({ type: Boolean }) autoScroll = true;

  @state() private renderedLogs: LogMessageData[] = [];
  private readonly containerRef: Ref<HTMLDivElement> = createRef();

  createRenderRoot(): HTMLElement {
    return this;
  }

  protected updated(changedProperties: PropertyValues): void {
    if (changedProperties.has('logs')) {
      this.renderedLogs = this.logs;
    }

    if (this.autoScroll && this.containerRef.value) {
      const container = this.containerRef.value;
      container.scrollTop = container.scrollHeight;
    }
  }

  render(): TemplateResult {
    return html`
      <div
        id="logContent"
        class="log-container"
        ${ref(this.containerRef)}
        @click=${this.handleClick}
        @toggle=${this.handleToggle}
      >
        ${this.renderGroups()}
      </div>
    `;
  }

  private renderGroups(): TemplateResult {
    if (this.logs.length === 0) {
      return html`
        <div class="log-placeholder">
          No runs yet—use TeXRA commands to start. Try
          <a href="command:texra.openGettingStarted"
            >open the getting started walkthrough</a
          >,
          <a href="command:texra.createSampleProject">create a sample project</a
          >,
          <a href="command:texra.cloneOverleafProject"
            >clone an Overleaf project</a
          >, or
          <a href="command:texra.downloadArXivSource"
            >download an arXiv source</a
          >.
        </div>
      `;
    }

    const groupedLogs = this.groupLogsById(this.logs);
    const rootGroups = Object.values(this.groups).filter(
      (group) => !group.parentGroupId,
    );
    const ungroupedLogs = groupedLogs.get('') ?? [];

    return html`
      ${this.renderLogEntries(ungroupedLogs)}
      ${repeat(
        rootGroups,
        (group) => group.id,
        (group) => this.renderGroup(group, groupedLogs),
      )}
    `;
  }

  private groupLogsById(logs: LogMessageData[]): Map<string, LogMessageData[]> {
    const map = new Map<string, LogMessageData[]>();
    for (const log of logs) {
      const key = log.groupId ?? '';
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(log);
      } else {
        map.set(key, [log]);
      }
    }
    return map;
  }

  private renderGroup(
    group: TaskGroup,
    groupedLogs: Map<string, LogMessageData[]>,
  ): TemplateResult {
    const children = Object.values(this.groups).filter(
      (child) => child.parentGroupId === group.id,
    );
    const logs = groupedLogs.get(group.id) ?? [];
    const isRoot = !group.parentGroupId;
    const detailsClasses = isRoot ? 'log-group log-run' : 'log-group';

    return html`
      <details class=${detailsClasses} data-run-id=${group.id} open>
        ${this.renderGroupHeader(group)}
        <div class="log-group-content" id=${`group-content-${group.id}`}>
          ${this.renderLogEntries(logs)}
          ${repeat(
            children,
            (child) => child.id,
            (child) => this.renderGroup(child, groupedLogs),
          )}
        </div>
      </details>
    `;
  }

  private renderGroupHeader(group: TaskGroup): TemplateResult {
    const startDate = new Date(group.startTime);
    const { timeDisplay } = formatTimestamp(startDate);
    const duration =
      group.endTime != null
        ? formatDuration(group.endTime - group.startTime)
        : '';

    return html`
      <summary class="log-group-header is-${group.status}">
        <span class="group-status-icon"
          >${this.renderStatusIcon(group.status)}</span
        >
        ${group.parentGroupId
          ? html`<span class="group-title">${group.name}</span>`
          : null}
        <span class="group-start-time" data-start=${group.startTime}
          ><i class="codicon codicon-clock"></i> ${timeDisplay}</span
        >
        ${duration
          ? html`<span class="group-duration">${duration}</span>`
          : null}
      </summary>
    `;
  }

  private renderStatusIcon(status: string): TemplateResult {
    switch (status) {
      case 'running':
        return html`<i class="codicon codicon-sync spin"></i>`;
      case 'error':
        return html`<i class="codicon codicon-error"></i>`;
      case 'stopped':
        return html`<i class="codicon codicon-check"></i>`;
      default:
        return html`<i class="codicon codicon-circle-outline"></i>`;
    }
  }

  private renderLogEntries(logs: LogMessageData[]): TemplateResult {
    const formatter = getSharedLogEntryFormatter();
    return html`${repeat(
      logs,
      (log) => log.id,
      (log) => {
        const htmlString = formatter.format(log);
        return htmlString ? html`${unsafeHTML(htmlString)}` : null;
      },
    )}`;
  }

  private async handleClick(event: Event) {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const fileLink = target.closest('.file-link') as HTMLElement | null;
    if (fileLink?.dataset.file) {
      this.emitCommand('openFile', {
        file: fileLink.dataset.file,
        ...(fileLink.dataset.fileLine && {
          line: Number(fileLink.dataset.fileLine),
        }),
      });
      return;
    }

    const latexRef = target.closest('.latex-ref') as HTMLElement | null;
    if (latexRef?.dataset.label) {
      this.emitCommand('openLabel', { label: latexRef.dataset.label });
      return;
    }

    const copyButton = target.closest(
      '.banner-content-copy',
    ) as HTMLElement | null;
    if (copyButton) {
      event.stopPropagation();
      const contentElem = copyButton
        .closest('.banner-details')
        ?.querySelector('.banner-content') as HTMLElement | null;
      if (!contentElem) return;
      const textToCopy =
        contentElem.dataset.rawContent ?? contentElem.textContent ?? '';
      if (!textToCopy.trim()) return;
      await navigator.clipboard.writeText(textToCopy);
      copyButton.classList.add('copy-success');
      copyButton.setAttribute('title', 'Copied!');
      window.setTimeout(() => {
        copyButton.classList.remove('copy-success');
        copyButton.setAttribute(
          'title',
          copyButton.dataset.defaultTitle || 'Copy content',
        );
      }, 1500);
      return;
    }

    const codeBlockCopy = target.closest(
      '.code-block-copy',
    ) as HTMLElement | null;
    if (codeBlockCopy) {
      event.stopPropagation();
      const codeBlock = codeBlockCopy.closest('.code-block');
      const codeElem = codeBlock?.querySelector('code');
      if (!codeElem) return;
      const textToCopy = codeElem.textContent ?? '';
      if (!textToCopy.trim()) return;
      await navigator.clipboard.writeText(textToCopy);
      codeBlockCopy.classList.add('copied');
      window.setTimeout(() => {
        codeBlockCopy.classList.remove('copied');
      }, 1500);
    }
  }

  private handleToggle(event: Event) {
    const target = event.target as HTMLElement | null;
    if (!target || !(target instanceof HTMLDetailsElement)) return;
    const toggleIcon = target.querySelector('.toggle-icon');
    if (!toggleIcon) return;
    toggleIcon.className = target.open
      ? 'codicon codicon-chevron-down toggle-icon'
      : 'codicon codicon-chevron-right toggle-icon';
  }

  private emitCommand(command: string, payload: Record<string, unknown>) {
    this.dispatchEvent(
      new CustomEvent('log-command', {
        detail: { command, ...payload },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
