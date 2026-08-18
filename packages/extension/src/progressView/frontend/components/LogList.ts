/**
 * LogList component - declarative log rendering with per-stream DOM caching.
 *
 * Consumes streamLogContext to get groups and messages.
 * Renders one TaskGroupList per visited stream, hiding inactive ones with
 * the hidden attribute. Tab switching toggles visibility — zero DOM
 * re-creation.
 *
 * Handles event delegation for clicks, toggles, and file links.
 *
 * Uses Shadow DOM with modular styles for encapsulation.
 */

// Third-party imports
import { LRUCache } from 'lru-cache';
import { LitElement, html, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { repeat } from 'lit/directives/repeat.js';
import { z } from 'zod';

// Local imports - side-effect: register component
import './TaskGroupList';

// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import '@shared/wa/spinner';
import type {
  LogMessageData,
  StreamLifecycleStatus,
  TaskGroup,
} from '@shared/schemas';
import { designTokens } from '@shared/styles';
import { postMessage } from '@shared/hostBridge';
import { PersistedState } from '@shared/state/PersistedState';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { copyWithFeedback } from '@shared/utils/clipboard';
import { logListStateKey, webviewStorage } from '../webviewStorage';
import { getComposedPathElement } from '../utils';

// Local imports - progress view contexts
import {
  EMPTY_LOG_CONTEXT,
  streamLogContext,
  type StreamLogContextValue,
} from '../streamContexts';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view formatters
import { getCopyContent, getProposalInput } from '../formatters/contentStore';

// Local imports - progress view components (type-only)
import type { TaskGroupList } from './TaskGroupList';

const LogListStateSchema = z.object({
  groupToggleStates: z.array(z.tuple([z.string(), z.boolean()])).prefault([]),
});

/** Cached per-stream data and DOM state */
interface CachedStream {
  groups: TaskGroup[];
  messages: LogMessageData[];
  updatedMessageIndices: readonly number[];
  updatedMessageBaseGeneration: number;
  messageGeneration: number;
  toggleStates: ToggleStateStore;
  ref: Ref<TaskGroupList>;
  status: StreamLifecycleStatus | null;
  /** Whether this cached stream is tool-use. */
  isToolUse: boolean;
  /** Whether to render this stream's logs in terminal style. */
  terminalMode: boolean;
  subagentExecutionLabels: ExecutionLabels;
}

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  // Log context - only updates when logs/groups change (not on metadata-only changes)
  @consume({ context: streamLogContext, subscribe: true })
  @state()
  private streamContext: StreamLogContextValue = EMPTY_LOG_CONTEXT;

  /** Max cached stream DOM trees. Oldest non-active entries are evicted beyond this. */
  private static readonly MAX_CACHED_STREAMS = 5;

  /** Per-stream DOM cache: one TaskGroupList per visited stream */
  private readonly streamCache = new LRUCache<string, CachedStream>({
    max: LogList.MAX_CACHED_STREAMS,
  });
  private activeStreamId: string | null = null;
  private shouldScrollToBottom = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.handleClickEvent);
    this.addEventListener('keydown', this.handleKeyEvent);
    this.addEventListener('file-click', this.handleFileClickEvent);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('click', this.handleClickEvent);
    this.removeEventListener('keydown', this.handleKeyEvent);
    this.removeEventListener('file-click', this.handleFileClickEvent);
    super.disconnectedCallback();
  }

  protected willUpdate(): void {
    const streamId = this.streamContext.streamName;

    // Detect stream switch
    if (streamId !== this.activeStreamId) {
      this.activeStreamId = streamId;
      this.shouldScrollToBottom = true;
    }

    // All streams removed — drop the entire cache
    if (!this.streamContext.hasStreams && this.streamCache.size > 0) {
      this.streamCache.clear();
      return;
    }

    // Update cache for active stream with latest context data
    if (streamId) {
      const entry = this.getOrCreateEntry(streamId);
      entry.groups = this.streamContext.taskGroups;
      entry.messages = this.streamContext.logs;
      entry.updatedMessageIndices = this.streamContext.updatedMessageIndices;
      entry.updatedMessageBaseGeneration =
        this.streamContext.updatedMessageBaseGeneration;
      entry.messageGeneration = this.streamContext.messageGeneration;
      entry.status = this.streamContext.streamStatus;
      entry.isToolUse = this.streamContext.isToolUse;
      entry.terminalMode = this.streamContext.terminalMode;
      entry.subagentExecutionLabels =
        this.streamContext.subagentExecutionLabels ?? new Map();
    }
  }

  override render(): TemplateResult {
    if (this.streamCache.size === 0 || !this.streamContext.hasStreams) {
      return html`<task-group-list
        .hasStreams=${this.streamContext.hasStreams}
        .streamStatus=${this.streamContext.streamStatus}
        .isToolUse=${this.streamContext.isToolUse}
      ></task-group-list>`;
    }

    return html`${repeat(
      // `rentries()` yields stream cache entries oldest-inserted first (the
      // reverse of `entries()`) — the DOM order of the per-stream task-group
      // lists below depends on that ordering, so don't swap it for `entries()`.
      // The cast is required because lru-cache types `rentries()` as yielding
      // heterogeneous `(K | V)[]` tuples; the runtime values are `[string,
      // CachedStream]`.
      this.streamCache.rentries() as Iterable<[string, CachedStream]>,
      ([id]) => id,
      ([id, data]) => html`
        <task-group-list
          ${ref(data.ref)}
          ?hidden=${id !== this.activeStreamId}
          .groups=${data.groups}
          .messages=${data.messages}
          .updatedMessageIndices=${data.updatedMessageIndices}
          .updatedMessageBaseGeneration=${data.updatedMessageBaseGeneration}
          .messageGeneration=${data.messageGeneration}
          .hasStreams=${this.streamContext.hasStreams}
          .streamStatus=${data.status}
          .isToolUse=${data.isToolUse}
          .toggleStates=${data.toggleStates}
          .subagentExecutionLabels=${data.subagentExecutionLabels}
          ?terminal=${data.terminalMode}
        ></task-group-list>
      `,
    )}`;
  }

  override updated(): void {
    const activeEl = this.activeStreamId
      ? this.streamCache.get(this.activeStreamId)?.ref.value
      : undefined;

    if (this.shouldScrollToBottom) {
      // Force scroll to bottom when switching to a different stream tab.
      // Re-sticky so future content updates auto-scroll.
      // Must wait for child TaskGroupList to finish rendering (updateComplete)
      // and then for a layout pass (requestAnimationFrame) so the log container
      // has an accurate scrollMax before we scroll.
      this.shouldScrollToBottom = false;
      void activeEl?.updateComplete.then(() => {
        requestAnimationFrame(() => {
          activeEl?.setSticky(true);
          activeEl?.scrollToBottom();
        });
      });
    } else {
      // Auto-scroll only when the user hasn't scrolled away (sticky)
      activeEl?.scrollToBottomIfSticky();
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  /** Get or create a cached entry for a stream, loading persisted toggle states */
  private getOrCreateEntry(streamId: string): CachedStream {
    const entry = this.streamCache.get(streamId);
    if (entry) {
      return entry;
    }

    const stateManager = new PersistedState(
      webviewStorage,
      logListStateKey(streamId),
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

    const createdEntry: CachedStream = {
      groups: [],
      messages: [],
      updatedMessageIndices: [],
      updatedMessageBaseGeneration: 0,
      messageGeneration: 0,
      toggleStates,
      ref: createRef<TaskGroupList>(),
      status: null,
      isToolUse: false,
      terminalMode: false,
      subagentExecutionLabels: new Map(),
    };
    this.streamCache.set(streamId, createdEntry);
    return createdEntry;
  }

  /** Handle click events for file links, copy buttons, etc. */
  private async handleClickEvent(event: Event): Promise<void> {
    if (!(event instanceof MouseEvent)) return;
    if (this.activateLinkFromEvent(event)) return;

    const copyButton = getComposedPathElement<HTMLElement>(
      event,
      '[data-copy-id]',
    );
    if (!copyButton) return;

    event.stopPropagation();
    const copyId = copyButton.dataset.copyId;
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

  /**
   * Keyboard activation (Enter/Space) for the focusable transcript link spans
   * (file-link / latex-ref). Copy buttons, the proposal-restore-link
   * ("Setup") control, and spill-artifact buttons are real
   * `<wa-button>`/`<button>` elements and are
   * already keyboard-activatable via native click synthesis (handled by the
   * click handler below), so they are intentionally excluded here to avoid
   * double-firing. proposal-restore-link additionally stops its own keydown
   * from propagating this far — see stopSummaryToggleKeydown — since each sits
   * inside a `<wa-details>` summary and would otherwise also toggle the
   * panel.
   */
  private handleKeyEvent(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.defaultPrevented) return;
    if (!getComposedPathElement<HTMLElement>(event, '.file-link, .latex-ref')) {
      return;
    }
    event.preventDefault();
    this.activateLinkFromEvent(event);
  }

  /**
   * Dispatch a file-link / latex-ref / proposal-restore-link activation from a
   * click or keydown event. Returns true when one was handled.
   */
  private activateLinkFromEvent(event: Event): boolean {
    const spillLink = getComposedPathElement<HTMLElement>(
      event,
      '.spill-artifact-link',
    );
    if (spillLink?.dataset.spillPath) {
      event.preventDefault();
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_SPILL_ARTIFACT, {
        spillPath: spillLink.dataset.spillPath,
      });
      return true;
    }

    const fileLink = getComposedPathElement<HTMLElement>(event, '.file-link');
    if (fileLink?.dataset.file) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, {
        file: fileLink.dataset.file,
        ...(fileLink.dataset.fileLine && {
          line: Number(fileLink.dataset.fileLine),
        }),
      });
      return true;
    }

    const latexRef = getComposedPathElement<HTMLElement>(event, '.latex-ref');
    if (latexRef?.dataset.label) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_LABEL, {
        label: latexRef.dataset.label,
      });
      return true;
    }

    // Handle proposal restore links. The wa-details toggle is suppressed
    // separately: WA's own click handler already excludes this real
    // <button>, and stopSummaryToggleKeydown stops its keydown from
    // reaching wa-details' summary at all — this preventDefault only
    // guards against any other native default action on the click.
    const proposalLink = getComposedPathElement<HTMLElement>(
      event,
      '.proposal-restore-link',
    );
    if (proposalLink?.dataset.proposalInputId) {
      event.preventDefault();
      const proposal = getProposalInput(proposalLink.dataset.proposalInputId);
      if (proposal) {
        postMessage(PROGRESS_VIEW_COMMANDS.RESTORE_PROPOSAL_CONFIG, {
          proposal,
        });
      }
      return true;
    }
    return false;
  }

  /** Handle file-click events from Shadow DOM components. */
  private handleFileClickEvent(event: Event): void {
    const { file, line } = (
      event as CustomEvent<{ file: string; line?: number }>
    ).detail;
    if (file) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, {
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
