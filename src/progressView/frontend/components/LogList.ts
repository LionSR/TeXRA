/**
 * LogList component - declarative log rendering for the active stream.
 *
 * Consumes streamLogContext to get groups, messages, activeRunId, and isToolUse.
 * Renders a single TaskGroupList for the active stream only.
 *
 * Handles event delegation for clicks, toggles, and file links.
 *
 * Uses Shadow DOM with modular styles for encapsulation.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';
import { z } from 'zod';

// Local imports - side-effect: register component
import './TaskGroupList';

// Local imports - shared webview
import { postMessage, vscode } from '@shared/vscode';

// Local imports - shared utilities
import { copyWithFeedback } from '@shared/utils/clipboard';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { PersistedState, createWebviewStorage } from '@shared/state';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - progress view constants
import { COMMANDS } from '../constants';

// Local imports - progress view contexts
import {
  streamLogContext,
  type StreamLogContextValue,
} from '../contexts/streamContexts';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view formatters
import { getCopyContent } from '../formatters/copyContentStore';
import { getProposalInput } from '../formatters/proposalInputStore';

// Local imports - progress view components (type-only)
import type { TaskGroupList } from './TaskGroupList';

// Local imports - shared schemas
import type { LogMessageData, TaskGroup } from '@shared/schemas';

const LogListStateSchema = z
  .object({
    groupToggleStates: z.array(z.tuple([z.string(), z.boolean()])).catch([]),
  })
  .catch({ groupToggleStates: [] });

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
  ];

  // Log context - only updates when logs/groups change (not on metadata-only changes)
  @consume({ context: streamLogContext, subscribe: true })
  @state()
  private streamContext?: StreamLogContextValue;

  private get groups(): TaskGroup[] {
    return this.streamContext?.taskGroups ?? [];
  }

  private get messages(): LogMessageData[] {
    return this.streamContext?.logs ?? [];
  }

  private get activeRunId(): string | null {
    return this.streamContext?.runId ?? null;
  }

  private get lastUpdatedLogId(): string | null {
    return this.streamContext?.lastUpdatedLogId ?? null;
  }

  private get lastUpdatedLogIndex(): number | null {
    return this.streamContext?.lastUpdatedLogIndex ?? null;
  }

  private get isToolUse(): boolean {
    return this.streamContext?.isToolUse ?? false;
  }

  private get hasStreams(): boolean {
    return this.streamContext?.hasStreams ?? false;
  }

  private storage = createWebviewStorage(vscode);
  private activeStreamId: string | null = null;
  private activeToggleStates: ToggleStateStore | null = null;
  private taskGroupListRef = createRef<TaskGroupList>();
  private shouldScrollToBottom = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.handleClickEvent);
    this.addEventListener('file-click', this.handleFileClickEvent);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('click', this.handleClickEvent);
    this.removeEventListener('file-click', this.handleFileClickEvent);
    super.disconnectedCallback();
  }

  protected willUpdate(): void {
    const streamId = this.streamContext?.streamName ?? null;

    // Detect stream switch
    if (streamId !== this.activeStreamId) {
      this.switchActiveStream(streamId);
    }
  }

  override render(): TemplateResult {
    return html`<task-group-list
      ${ref(this.taskGroupListRef)}
      .groups=${this.groups}
      .messages=${this.messages}
      .lastUpdatedLogId=${this.lastUpdatedLogId}
      .lastUpdatedLogIndex=${this.lastUpdatedLogIndex}
      .activeRunId=${this.activeRunId}
      .isToolUse=${this.isToolUse}
      .hasStreams=${this.hasStreams}
      .toggleStates=${this.activeToggleStates}
    ></task-group-list>`;
  }

  override updated(): void {
    const activeEl = this.taskGroupListRef.value;

    if (this.shouldScrollToBottom) {
      // Force scroll to bottom when switching to a different stream tab.
      // Must wait for child TaskGroupList to finish rendering (updateComplete)
      // and then for a layout pass (requestAnimationFrame) so vscode-scrollable
      // has an accurate scrollMax before we scroll.
      this.shouldScrollToBottom = false;
      void activeEl?.updateComplete.then(() => {
        requestAnimationFrame(() => {
          activeEl?.scrollToBottom();
        });
      });
    } else {
      // Scroll to bottom after render if the user is already near the end
      activeEl?.scrollToBottomIfNearEnd();
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  private switchActiveStream(streamId: string | null): void {
    this.activeStreamId = streamId;
    this.shouldScrollToBottom = true;
    this.activeToggleStates = streamId
      ? this.createToggleStateStore(streamId)
      : null;
  }

  /** Create toggle state store for active stream from persisted state. */
  private createToggleStateStore(streamId: string): ToggleStateStore {
    const stateManager = new PersistedState(
      this.storage,
      `logListState:${streamId}`,
      LogListStateSchema,
    );
    const toggleStates = new ToggleStateStore(() => {
      try {
        stateManager.update({ groupToggleStates: toggleStates.entries() });
      } catch (error) {
        console.error('[LogList] Failed to save toggle states', error);
      }
    });
    const previous = stateManager.getState();
    if (previous.groupToggleStates.length > 0) {
      toggleStates.load(previous.groupToggleStates);
    }
    return toggleStates;
  }

  /** Handle click events for file links, copy buttons, etc. */
  private async handleClickEvent(event: Event): Promise<void> {
    if (!(event instanceof MouseEvent)) return;
    const fileLink = this.findTargetInPath<HTMLElement>(event, '.file-link');
    if (fileLink?.dataset.file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file: fileLink.dataset.file,
        ...(fileLink.dataset.fileLine && {
          line: Number(fileLink.dataset.fileLine),
        }),
      });
      return;
    }

    const latexRef = this.findTargetInPath<HTMLElement>(event, '.latex-ref');
    if (latexRef?.dataset.label) {
      postMessage(COMMANDS.OPEN_LABEL, { label: latexRef.dataset.label });
      return;
    }

    // Handle proposal restore links (may be inside <summary>, so prevent toggle)
    const proposalLink = this.findTargetInPath<HTMLElement>(
      event,
      '.proposal-restore-link',
    );
    if (proposalLink?.dataset.proposalId) {
      event.preventDefault();
      const proposal = getProposalInput(proposalLink.dataset.proposalId);
      if (proposal) {
        postMessage(COMMANDS.RESTORE_PROPOSAL_CONFIG, { proposal });
      }
      return;
    }

    // Handle copy buttons - content is stored in the copy registry
    const copyButton = this.findTargetInPath<HTMLElement>(
      event,
      '[data-copy-id]',
    );
    if (copyButton) {
      event.stopPropagation();
      const copyId = copyButton.dataset.copyId ?? '';
      const textToCopy = copyId ? (getCopyContent(copyId) ?? '') : '';
      if (!textToCopy.trim()) return;

      const isCodeBlock = copyButton.dataset.copyType === 'code-block';
      await copyWithFeedback(copyButton, textToCopy, {
        defaultTitle:
          copyButton.dataset.defaultTitle ||
          copyButton.getAttribute('title') ||
          'Copy to clipboard',
        successTitle: copyButton.dataset.successTitle || 'Copied!',
        successClass: isCodeBlock ? 'copied' : undefined,
      });
    }
  }

  private findTargetInPath<T extends Element>(
    event: Event,
    selector: string,
  ): T | null {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.matches(selector)) {
        return node as T;
      }
    }
    return null;
  }

  /** Handle file-click events from Shadow DOM components. */
  private handleFileClickEvent(event: Event): void {
    const { file, line } = (
      event as CustomEvent<{ file: string; line?: number }>
    ).detail;
    if (file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file,
        ...(line !== undefined && { line }),
      });
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'log-list': LogList;
  }
}
