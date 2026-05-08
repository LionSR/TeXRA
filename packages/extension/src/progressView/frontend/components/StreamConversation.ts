/**
 * `<stream-conversation>` — the body of the Progress view's active stream.
 *
 * Hoisted out of `ProgressApp.renderStreamContent()` (PRD:
 * docs/prd/electron-shell-layout.md § 7.B). Subscribes to module-level signals
 * from `../progressState.ts` so the conversation body can mount independently
 * of `<progress-app>` — required for the Electron three-pane shell (PR 3) where
 * `<stream-conversation>` and `<stream-tabs>` live in different DOM trees.
 *
 * Behavior preservation: the rendered tree, child events, and Lit context
 * provider values match the previous `ProgressApp` body exactly. The page-
 * level "no runs yet" empty-state remains owned by `<progress-app>` for now —
 * see the PR description for why we deferred that part of the PRD wording.
 */

// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

// Local imports - shared
import { isProcessAgent } from '@shared/streams/agentKind';
import { SignalWatcher } from '@shared/signals';

// Local imports - progress view
import {
  activeProcessOutputs$,
  logContext$,
  permissions$,
  streamById$,
  streamContext$,
} from '../progressState';
import {
  EMPTY_LOG_CONTEXT,
  EMPTY_PROCESS_OUTPUTS,
  EMPTY_STREAM_BY_ID,
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  processOutputContext,
  streamByIdContext,
  streamLogContext,
  streamStateContext,
  type ProcessOutputMap,
  type StreamByIdMap,
  type StreamContextValue,
  type StreamLogContextValue,
} from '../contexts/streamContexts';
import type { PermissionState } from './PermissionCard';

// Side-effect imports - body components rendered below.
import './ToolUseStreamContent';
import './WorkflowStreamContent';
import './ProcessStreamContent';
import './LogList';

@customElement('stream-conversation')
export class StreamConversation extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    /* Stream content containers - pass-through for layout, mirrors
       the equivalent block previously in ProgressApp.styles. */
    tool-use-stream-content,
    workflow-stream-content,
    process-stream-content {
      display: contents;
    }
  `;

  // ---- Lit context providers --------------------------------------------
  // Identical shape and update timing to the providers that previously lived
  // on `<progress-app>`. Descendants (`workflow-stream-content`, `log-list`,
  // `background-tasks-panel`, …) are unchanged.

  @provide({ context: streamStateContext })
  @state()
  private streamContextValue: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @provide({ context: streamLogContext })
  @state()
  private streamLogContextValue: StreamLogContextValue = EMPTY_LOG_CONTEXT;

  @provide({ context: permissionsContext })
  @state()
  private permissionsContextValue: PermissionState[] = [];

  @provide({ context: processOutputContext })
  @state()
  private processOutputContextValue: ProcessOutputMap = EMPTY_PROCESS_OUTPUTS;

  @provide({ context: streamByIdContext })
  @state()
  private streamByIdContextValue: StreamByIdMap = EMPTY_STREAM_BY_ID;

  /**
   * Sync signal-computed values into @provide/@state context properties.
   * SignalWatcher triggers requestUpdate() when any read signal changes,
   * so this runs only when computed values actually propagate. Mirrors the
   * willUpdate() previously in ProgressApp.
   */
  protected override willUpdate(): void {
    this.streamContextValue = streamContext$.get();
    this.streamLogContextValue = logContext$.get();
    this.permissionsContextValue = permissions$.get();
    this.processOutputContextValue = activeProcessOutputs$.get();
    this.streamByIdContextValue = streamById$.get();
  }

  override render(): TemplateResult {
    const { streamInfo, streamState, isToolUse } = this.streamContextValue;

    // No active stream — show empty log-list. Identical to the prior
    // `renderStreamContent` early return.
    if (!streamInfo || !streamState) {
      return html`<log-list></log-list>`;
    }

    // Process agents (e.g. bash) proxy raw stdout/stderr — render them with
    // a dedicated terminal-style container, not the LLM workflow/tool-use
    // chrome.
    if (isProcessAgent(streamInfo.agent)) {
      return html`<process-stream-content></process-stream-content>`;
    }

    if (isToolUse) {
      return html`<tool-use-stream-content></tool-use-stream-content>`;
    }

    // Workflow stream (default for non-tool-use).
    return html`<workflow-stream-content></workflow-stream-content>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-conversation': StreamConversation;
  }
}
