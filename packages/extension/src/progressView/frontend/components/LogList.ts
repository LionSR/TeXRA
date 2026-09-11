/**
 * The transcript of one run, on the fold's transcript slice. It keeps one
 * `<task-group-list>` per recently shown run so a switch back restores
 * scroll and render windows, and it maps the file, spill, and label links
 * inside rows to `host-request` arms. Group expansion is the surface's
 * (`Surface.groups`): the list reads the run's map and every toggle is
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
import type { RunId } from '@shared/schemas';
import { designTokens } from '@shared/styles';
import type { RunView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { getComposedPathElement } from '../utils';
import { logStyles } from '../styles/logStyles';
import type { TaskGroupList } from './TaskGroupList';

interface CachedRun {
  run: RunView;
  ref: Ref<TaskGroupList>;
}

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;

  private static readonly MAX_CACHED_RUNS = 5;
  private readonly runCache = new LRUCache<RunId, CachedRun>({
    max: LogList.MAX_CACHED_RUNS,
  });
  private activeRunId: RunId | null = null;
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
    const run = this.run;
    const runId = run?.id ?? null;
    if (runId !== this.activeRunId) {
      this.activeRunId = runId;
      this.shouldScrollToBottom = true;
    }
    if (!run) {
      if (this.runCache.size > 0) this.runCache.clear();
      return;
    }
    this.getOrCreateEntry(run.id).run = run;
  }

  override render(): TemplateResult {
    if (!this.run) {
      return html`<task-group-list
        role="log"
        aria-label="Run activity"
        aria-relevant="additions"
        .hasRuns=${false}
        .runStatus=${undefined}
        .durableOutcome=${null}
        .isToolUse=${false}
      ></task-group-list>`;
    }
    return html`${repeat(
      this.runCache.rentries() as Iterable<[RunId, CachedRun]>,
      ([id]) => id,
      ([id, data]) => {
        const run = data.run;
        const terminal = run.identity.kind === 'process';
        return html`
          <task-group-list
            ${ref(data.ref)}
            role=${terminal ? nothing : 'log'}
            aria-label=${terminal ? nothing : `Activity for ${run.label}`}
            aria-relevant=${terminal ? nothing : 'additions'}
            ?hidden=${id !== this.activeRunId}
            .runId=${id}
            .transcript=${run.transcript}
            .hasRuns=${true}
            .runStatus=${run.status}
            .durableOutcome=${run.durableOutcome}
            .isToolUse=${run.category === 'toolUse'}
            .expanded=${this.surface?.groups.get(id)}
            ?terminal=${terminal}
          ></task-group-list>
        `;
      },
    )}`;
  }

  override updated(): void {
    const activeEl = this.activeRunId
      ? this.runCache.get(this.activeRunId)?.ref.value
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

  private getOrCreateEntry(runId: RunId): CachedRun {
    const entry = this.runCache.get(runId);
    if (entry) return entry;
    const created: CachedRun = {
      run: this.run!,
      ref: createRef<TaskGroupList>(),
    };
    this.runCache.set(runId, created);
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
