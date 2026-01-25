// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared webview
import { postMessage } from '@shared/vscode';

// Local imports - common helpers
import {
  scrollToBottom,
  setChevronIconHorizontal,
} from '@common/modules/domUtils.js';
import { copyWithFeedback } from '@common/modules/clipboardUtils.js';
import { WebviewStateManager } from '@common/modules/webviewState.js';
import { ToggleStateStore } from '@common/modules/ToggleStateStore.js';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';
import { appendFormatted } from '../utils';

// Local imports - progress view managers
import {
  TaskGroupDomManager,
  LogEntryManager,
} from '../managers/TaskGroupDomManager';

// Local imports - shared schemas
import type {
  InstructionUpdate,
  LogMessageData,
  TaskGroup,
} from '@shared/schemas';
const PLACEHOLDER_HTML =
  'No runs yet—use TeXRA commands to start. Try ' +
  '<a href="command:texra.openGettingStarted">open the getting started walkthrough</a>, ' +
  '<a href="command:texra.createSampleProject">create a sample project</a>, ' +
  '<a href="command:texra.cloneOverleafProject">clone an Overleaf project</a>, or ' +
  '<a href="command:texra.downloadArXivSource">download an arXiv source</a>.';

@customElement('log-list')
export class LogList extends LitElement {
  private stateManager: WebviewStateManager;
  private toggleStates: ToggleStateStore;
  private groupManager: TaskGroupDomManager;
  private logManager: LogEntryManager;
  private lastRenderedStream: string;
  private activeAgentCategory: string;
  private boundToggleHandler: (event: Event) => void;
  private boundClickHandler: (event: MouseEvent) => void;

  constructor() {
    super();
    this.stateManager = new WebviewStateManager();
    const previous = this.stateManager.getState();
    this.toggleStates = new ToggleStateStore(() => this.saveToggleStates());
    if (Array.isArray(previous?.groupToggleStates)) {
      this.toggleStates.load(previous.groupToggleStates);
    }
    this.groupManager = new TaskGroupDomManager(this.toggleStates, this);
    this.logManager = new LogEntryManager(this);
    this.lastRenderedStream = '';
    this.activeAgentCategory = 'workflow';
    this.boundToggleHandler = this.handleToggleEvent.bind(this);
    this.boundClickHandler = this.handleClickEvent.bind(this);
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('toggle', this.boundToggleHandler, true);
    document.addEventListener('click', this.boundClickHandler, true);
  }

  disconnectedCallback(): void {
    document.removeEventListener('toggle', this.boundToggleHandler, true);
    document.removeEventListener('click', this.boundClickHandler, true);
    super.disconnectedCallback();
  }

  render(): TemplateResult {
    return html`<div
      id=${ELEMENT_IDS.LOG_CONTENT}
      class="log-container"
    ></div>`;
  }

  setAgentCategory(category: string): void {
    this.activeAgentCategory = category ?? 'workflow';
    this.groupManager.setActiveAgentCategory(this.activeAgentCategory);
  }

  renderLogs({
    streamId,
    messages = [],
    groups = [],
    action = 'render',
    activeRunId = null,
    runInstructions = null,
  }: {
    streamId?: string | null;
    messages?: LogMessageData[];
    groups?: TaskGroup[];
    action?: 'render' | 'clear';
    activeRunId?: string | null;
    runInstructions?: Record<string, InstructionUpdate> | null;
  }): void {
    const container = this.getContainer();
    if (!container) return;

    // Always clear before full render to prevent duplicate content.
    // The 'render' action replaces content; 'clear' clears without re-rendering.
    container.innerHTML = '';
    this.groupManager.clear();
    this.logManager.clear();

    if (action === 'clear') {
      this.lastRenderedStream = streamId ?? '';
      this.showPlaceholderIfEmpty([], []);
      return;
    }

    const sortedMessages = [...messages].sort((a, b) => {
      const timeA = a.timestamp ?? 0;
      const timeB = b.timestamp ?? 0;
      return timeA - timeB;
    });

    const isToolUse = this.activeAgentCategory === 'toolUse';
    if (isToolUse && sortedMessages.length > 0) {
      const firstMsg = sortedMessages[0];
      const hasUserMessageFirst = firstMsg.messageType === 'userMessage';
      if (!hasUserMessageFirst && runInstructions) {
        const instruction = Object.values(runInstructions)[0];
        if (instruction?.text) {
          const timestamp =
            instruction.timestamp ?? (firstMsg.timestamp ?? Date.now()) - 1;
          sortedMessages.unshift({
            id: `compat-instruction-${streamId}`,
            messageType: 'userMessage',
            text: instruction.text,
            timestamp,
            level: 'info',
          });
        }
      }
    }

    this.groupManager.showRun(groups.length > 0 ? activeRunId : null);
    if (groups.length > 0) {
      this.groupManager.renderInitial(groups, container);
    }

    const ungroupedFragment = document.createDocumentFragment();
    const userMessageFragment = isToolUse
      ? document.createDocumentFragment()
      : null;
    const groupedFragments = new Map<string, DocumentFragment>();

    for (const msg of sortedMessages) {
      const formatted = this.logManager.entryFormatter.format(msg);
      if (!formatted) continue;

      if (msg.groupId) {
        const groupContainer = this.getGroupContainer(msg.groupId);
        if (groupContainer) {
          let frag = groupedFragments.get(msg.groupId);
          if (!frag) {
            frag = document.createDocumentFragment();
            groupedFragments.set(msg.groupId, frag);
          }
          appendFormatted(frag, formatted);
        } else {
          appendFormatted(ungroupedFragment, formatted);
        }
      } else if (
        isToolUse &&
        msg.messageType === 'userMessage' &&
        userMessageFragment
      ) {
        appendFormatted(userMessageFragment, formatted);
      } else {
        appendFormatted(ungroupedFragment, formatted);
      }
    }

    if (isToolUse) {
      if (ungroupedFragment.childNodes.length > 0) {
        container.prepend(ungroupedFragment);
      }
      if (userMessageFragment && userMessageFragment.childNodes.length > 0) {
        container.prepend(userMessageFragment);
      }
    }

    for (const [groupId, frag] of groupedFragments) {
      const groupContainer = this.getGroupContainer(groupId);
      if (groupContainer) {
        groupContainer.appendChild(frag);
      } else {
        container.appendChild(frag);
      }
    }

    if (!isToolUse && ungroupedFragment.childNodes.length > 0) {
      container.appendChild(ungroupedFragment);
    }

    scrollToBottom(container);
    this.lastRenderedStream = streamId ?? '';
    this.showPlaceholderIfEmpty(sortedMessages, groups);
  }

  appendLog(
    logMessage: LogMessageData,
    options: { defaultOpen?: boolean } = {},
  ): void {
    const container = this.getContainer();
    if (!container) return;

    const appendedToGroup = this.logManager.append(logMessage, options);
    if (!appendedToGroup) {
      const formatted = this.logManager.entryFormatter.format(
        logMessage,
        options,
      );
      if (formatted) {
        appendFormatted(container, formatted);
      }
    }
    scrollToBottom(container);
  }

  updateLog(logMessage: LogMessageData): void {
    const updated = this.logManager.update(logMessage);
    if (!updated) {
      this.appendLog(logMessage);
    }
  }

  addGroup(group: TaskGroup): void {
    const container = this.getContainer();
    if (!container) return;
    this.groupManager.addGroup(group);
  }

  updateGroup(update: Partial<TaskGroup> & { id: string }): void {
    this.groupManager.updateGroup(update);
  }

  showRun(runId: string | null): void {
    this.groupManager.showRun(runId);
  }

  clear(): void {
    const container = this.getContainer();
    if (container) {
      container.innerHTML = '';
    }
    this.groupManager.clear();
    this.logManager.clear();
    this.lastRenderedStream = '';
    // Show placeholder when cleared (no active stream)
    this.showPlaceholderIfEmpty([], []);
  }

  private getContainer(): HTMLElement | null {
    return this.querySelector(`#${ELEMENT_IDS.LOG_CONTENT}`);
  }

  private getGroupContainer(groupId: string): HTMLElement | null {
    return this.querySelector(`#group-content-${groupId}`);
  }

  private showPlaceholderIfEmpty(
    messages: LogMessageData[],
    groups: TaskGroup[],
  ): void {
    const container = this.getContainer();
    if (!container) return;
    if (messages.length > 0 || groups.length > 0) {
      return;
    }

    const placeholder = document.createElement('div');
    placeholder.id = ELEMENT_IDS.LOG_PLACEHOLDER;
    placeholder.className = 'log-placeholder';
    placeholder.innerHTML = PLACEHOLDER_HTML;
    container.innerHTML = '';
    container.appendChild(placeholder);
  }

  private saveToggleStates(): void {
    try {
      this.stateManager.update({
        groupToggleStates: this.toggleStates.entries(),
      });
    } catch (error) {
      console.error('[LogList] Failed to save toggle states', error);
    }
  }

  private handleToggleEvent(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const hasToggleClass = [
      'banner-details',
      'file-list-details',
      'latexdiff-details',
      'statistics-details',
    ].some((cls) => target.classList.contains(cls));
    if (!hasToggleClass) return;

    const toggleIcon = target.querySelector('.toggle-icon');
    if (
      toggleIcon instanceof HTMLElement &&
      target instanceof HTMLDetailsElement
    ) {
      setChevronIconHorizontal(toggleIcon, target.open);
    }
  }

  private async handleClickEvent(event: MouseEvent): Promise<void> {
    const target = event.target as Element | null;
    if (!target) return;

    const fileLink = target.closest('.file-link') as HTMLElement | null;
    if (fileLink?.dataset.file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file: fileLink.dataset.file,
        ...(fileLink.dataset.fileLine && {
          line: Number(fileLink.dataset.fileLine),
        }),
      });
      return;
    }

    const latexRef = target.closest('.latex-ref') as HTMLElement | null;
    if (latexRef?.dataset.label) {
      postMessage(COMMANDS.OPEN_LABEL, { label: latexRef.dataset.label });
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

      await copyWithFeedback(copyButton, textToCopy, {
        defaultTitle:
          copyButton.dataset.defaultTitle ||
          copyButton.getAttribute('title') ||
          'Copy content',
        successTitle: copyButton.dataset.successTitle || 'Copied!',
      });
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
      await copyWithFeedback(codeBlockCopy, textToCopy, {
        defaultTitle: 'Copy to clipboard',
        successTitle: 'Copied!',
        successClass: 'copied',
      });
    }
  }
}
