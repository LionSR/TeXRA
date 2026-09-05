/**
 * The transcript of one stream, on the fold's transcript slice. It keeps one
 * `<task-group-list>` per recently shown stream so a switch back restores
 * scroll and render windows, and it maps the file, spill, and label links
 * inside rows to `host-request` arms. Group expansion is the surface's
 * (`Surface.groups`): the list reads the stream's map and every toggle is
 * dispatched as a `SurfaceAction`, never kept here.
 */
import { LRUCache } from 'lru-cache';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { repeat } from 'lit/directives/repeat.js';

import './TaskGroupList';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@shared/wa/spinner';
import type { StreamTabId } from '@shared/schemas';
import { designTokens } from '@shared/styles';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { getComposedPathElement } from '../utils';
import { logStyles } from '../styles/logStyles';
import type { TaskGroupList } from './TaskGroupList';

interface CachedStream {
  stream: StreamView;
  ref: Ref<TaskGroupList>;
}

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  @property({ attribute: false }) stream: StreamView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** The host's clock, for the dispatch card's elapsed times (G4). */
  @property({ type: Number }) nowMs: number | null = null;

  private static readonly MAX_CACHED_STREAMS = 5;
  private readonly streamCache = new LRUCache<StreamTabId, CachedStream>({
    max: LogList.MAX_CACHED_STREAMS,
  });
  private activeStreamId: StreamTabId | null = null;
  private shouldScrollToBottom = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.handleClickEvent);
    this.addEventListener('keydown', this.handleKeyEvent);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('click', this.handleClickEvent);
    this.removeEventListener('keydown', this.handleKeyEvent);
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    const stream = this.stream;
    const streamId = stream?.id ?? null;
    if (streamId !== this.activeStreamId) {
      this.activeStreamId = streamId;
      this.shouldScrollToBottom = true;
    }
    if (!stream) {
      if (this.streamCache.size > 0) this.streamCache.clear();
      return;
    }
    this.getOrCreateEntry(stream.id).stream = stream;
  }

  override render(): TemplateResult {
    if (!this.stream) {
      return html`<task-group-list
        role="log"
        aria-label="Run activity"
        aria-relevant="additions"
        .hasStreams=${false}
        .streamStatus=${undefined}
        .streamDurablyFinal=${false}
        .isToolUse=${false}
      ></task-group-list>`;
    }
    return html`${repeat(
      this.streamCache.rentries() as Iterable<[StreamTabId, CachedStream]>,
      ([id]) => id,
      ([id, data]) => {
        const stream = data.stream;
        const terminal = stream.identity?.kind === 'process';
        return html`
          <task-group-list
            ${ref(data.ref)}
            role=${terminal ? nothing : 'log'}
            aria-label=${terminal ? nothing : `Activity for ${stream.label}`}
            aria-relevant=${terminal ? nothing : 'additions'}
            ?hidden=${id !== this.activeStreamId}
            .streamId=${id}
            .stream=${stream}
            .view=${this.view}
            .nowMs=${this.nowMs}
            .transcript=${stream.transcript}
            .hasStreams=${true}
            .streamStatus=${stream.status}
            .streamDurablyFinal=${stream.durableOutcome !== null}
            .isToolUse=${stream.category === 'toolUse'}
            .expanded=${this.surface?.groups.get(id)}
            ?terminal=${terminal}
          ></task-group-list>
        `;
      },
    )}`;
  }

  override updated(): void {
    const activeEl = this.activeStreamId
      ? this.streamCache.get(this.activeStreamId)?.ref.value
      : undefined;
    if (this.shouldScrollToBottom) {
      this.shouldScrollToBottom = false;
      void activeEl?.updateComplete.then(() => {
        requestAnimationFrame(() => {
          activeEl?.setSticky(true);
          activeEl?.scrollToBottom();
        });
      });
    } else {
      activeEl?.scrollToBottomIfSticky();
    }
  }

  private getOrCreateEntry(streamId: StreamTabId): CachedStream {
    const entry = this.streamCache.get(streamId);
    if (entry) return entry;
    const created: CachedStream = {
      stream: this.stream!,
      ref: createRef<TaskGroupList>(),
    };
    this.streamCache.set(streamId, created);
    return created;
  }

  private handleClickEvent = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    this.activateLinkFromEvent(event);
  };

  private handleKeyEvent = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.defaultPrevented) return;
    if (!getComposedPathElement<HTMLElement>(event, '.file-link, .latex-ref')) {
      return;
    }
    event.preventDefault();
    this.activateLinkFromEvent(event);
  };

  private activateLinkFromEvent(event: Event): void {
    const spillLink = getComposedPathElement<HTMLElement>(
      event,
      '.spill-artifact-link',
    );
    if (spillLink?.dataset.spillPath) {
      event.preventDefault();
      this.dispatchEvent(
        SessionUiEvents.host({
          kind: 'openSpillArtifact',
          spillPath: spillLink.dataset.spillPath,
        }),
      );
      return;
    }
    const fileLink = getComposedPathElement<HTMLElement>(event, '.file-link');
    if (fileLink?.dataset.file) {
      const line = Number(fileLink.dataset.fileLine);
      this.dispatchEvent(
        SessionUiEvents.host({
          kind: 'openFile',
          path: fileLink.dataset.file,
          line: Number.isInteger(line) && line > 0 ? line : null,
        }),
      );
      return;
    }
    const latexRef = getComposedPathElement<HTMLElement>(event, '.latex-ref');
    if (latexRef?.dataset.label) {
      this.dispatchEvent(
        SessionUiEvents.host({
          kind: 'openLabel',
          label: latexRef.dataset.label,
        }),
      );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'log-list': LogList;
  }
}
