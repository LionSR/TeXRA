/**
 * The transcript of one run, on the session view's transcript slice. It keeps one
 * `<stage-list>` per recently shown run so a switch back restores
 * scroll and render windows, and it maps the file and label links
 * inside rows to `host-request` arms. Group expansion is the surface's
 * (`RunSurface.disclosures`): the list reads the run's map and every toggle is
 * dispatched as a `SurfaceAction`, never kept here.
 */
import { LRUCache } from 'lru-cache';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { repeat } from 'lit/directives/repeat.js';

import './StageList';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@ui/wa/spinner';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { designTokens } from '@ui/styles';
import { getComposedPathElement } from './composedPath';
import { logStyles } from '../styles/logStyles';
import type { RunView, SessionView, RunId } from '@texra-ai/harness/schemas';
import type { StageList } from './StageList';

interface CachedRun {
  run: RunView;
  ref: Ref<StageList>;
}

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** Set by the run content, from the snapshot it renders under. */
  @property({ attribute: false }) tools!: HostSnapshot['tools'];

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
    const entry = this.runCache.get(run.id);
    if (entry) entry.run = run;
    else this.runCache.set(run.id, { run, ref: createRef<StageList>() });
  }

  override render(): TemplateResult | typeof nothing {
    // The run bodies mount the transcript only for a run.
    if (!this.run) return nothing;
    // Each entry is cached under its run's id.
    const entries = [...this.runCache.rvalues()].filter(
      (entry) => entry !== undefined,
    );
    return html`${repeat(
      entries,
      (data) => data.run.id,
      (data) => {
        const run = data.run;
        const id = run.id;
        const terminal = run.identity.kind === 'process';
        return html`
          <stage-list
            ${ref(data.ref)}
            role=${terminal ? nothing : 'log'}
            aria-label=${terminal ? nothing : `Activity for ${run.label}`}
            aria-relevant=${terminal ? nothing : 'additions'}
            ?hidden=${id !== this.activeRunId}
            .runId=${id}
            .run=${run}
            .view=${id === this.activeRunId ? this.view : null}
            .surface=${this.surface}
            .tools=${this.tools}
            .transcript=${run.transcript}
            .expanded=${this.surface?.runs.get(id)?.disclosures}
            ?terminal=${terminal}
          ></stage-list>
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
          activeEl.setSticky(true);
          activeEl.scrollToBottom();
        });
      });
    } else {
      activeEl?.scrollToBottomIfSticky();
    }
  }

  private handleClickEvent = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    this.activateLinkFromEvent(event);
  };

  private handleKeyEvent = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.defaultPrevented) return;
    if (!getComposedPathElement(event, '.file-link, .latex-ref', HTMLElement)) {
      return;
    }
    event.preventDefault();
    this.activateLinkFromEvent(event);
  };

  private activateLinkFromEvent(event: Event): void {
    const fileLink = getComposedPathElement(event, '.file-link', HTMLElement);
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
    const latexRef = getComposedPathElement(event, '.latex-ref', HTMLElement);
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
