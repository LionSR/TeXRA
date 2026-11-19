/**
 * The transcript of one run, on the session view's transcript slice. It keeps one
 * `<stage-list>` per recently shown run so a switch back restores
 * scroll and render windows, and it maps the file and label links
 * inside rows to `host-request` commands. Group expansion is the surface's
 * (`RunSurface.disclosures`): the list reads the run's map and every toggle is
 * dispatched as a `SurfaceAction`, never kept here.
 */
import { LRUCache } from 'lru-cache';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import './StageList';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@ui/wa/spinner';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { designTokens } from '@ui/styles';
import { delegateKeyActivation, getComposedPathElement } from './composedPath';
import { logStyles } from '../styles/logStyles';
import type { RunView, SessionView, RunId } from '@texra-ai/harness/schemas';

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** Set by the run content, from the snapshot it renders under. */
  @property({ attribute: false }) tools!: HostSnapshot['tools'];

  private static readonly MAX_CACHED_RUNS = 5;
  private readonly runCache = new LRUCache<RunId, RunView>({
    max: LogList.MAX_CACHED_RUNS,
  });

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
    if (!run) {
      if (this.runCache.size > 0) this.runCache.clear();
      return;
    }
    this.runCache.set(run.id, run);
  }

  override render(): TemplateResult | typeof nothing {
    // The run bodies mount the transcript only for a run.
    if (!this.run) return nothing;
    // Each entry is cached under its run's id.
    const runs = [...this.runCache.rvalues()].filter(
      (run) => run !== undefined,
    );
    const activeRunId = this.run.id;
    return html`${repeat(
      runs,
      (run) => run.id,
      (run) => {
        const id = run.id;
        const shown = id === activeRunId;
        const terminal = run.identity.kind === 'process';
        return html`
          <stage-list
            role=${terminal ? nothing : 'log'}
            aria-label=${terminal ? nothing : `Activity for ${run.label}`}
            aria-relevant=${terminal ? nothing : 'additions'}
            .shown=${shown}
            .runId=${id}
            .run=${run}
            .view=${shown ? this.view : null}
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

  private handleClickEvent = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    this.activateLinkFromEvent(event);
  };

  private handleKeyEvent = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    delegateKeyActivation(event, '.file-link, .latex-ref', () =>
      this.activateLinkFromEvent(event),
    );
  };

  private activateLinkFromEvent(event: Event): void {
    const fileLink = getComposedPathElement(event, '.file-link', HTMLElement);
    if (fileLink?.dataset.file) {
      const line = Number(fileLink.dataset.fileLine);
      this.dispatchEvent(
        SessionUiEvents.host({
          kind: 'openFile',
          path: fileLink.dataset.file,
          ...(Number.isInteger(line) && line > 0 && { line }),
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
