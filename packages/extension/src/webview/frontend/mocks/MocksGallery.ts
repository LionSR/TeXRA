// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/icon/icon.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

// Keep the gallery self-contained: importing this file alone is enough to
// render every section. ES module dedup makes the second registration path
// (via ./index.ts) a no-op.
import './YoloToggleMock';
import './ContextUtilizationMock';
import './TodoListMock';
import './FollowupControlsMock';
import './ProgressBoardLayoutMock';

/**
 * Static design gallery for proposed UI affordances. All children are
 * visual-only mocks; nothing here is wired to real state. Mount by
 * setting `localStorage.setItem('texra-mocks','1')` and reloading the
 * main webview — see MainApp.ts.
 */
@customElement('texra-mocks-gallery')
export class MocksGallery extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
        padding: var(--wa-space-s);
      }

      .heading {
        font-weight: var(--font-weight-medium);
        font-size: var(--font-size-lg);
        margin-bottom: var(--wa-space-3xs);
      }

      .subheading {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
        margin-bottom: var(--wa-space-m);
      }

      .section {
        margin-bottom: var(--wa-space-l);
      }

      .section__title {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--wa-space-3xs);
      }

      .section__desc {
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
        margin-bottom: var(--wa-space-2xs);
      }

      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--wa-space-s);
      }

      .header-strip {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) var(--wa-space-s);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default, transparent);
      }

      .header-strip__label {
        flex: 1;
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <div class="heading">
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="flask"
          variant="solid"
        ></wa-icon>
        Design mocks
      </div>
      <div class="subheading">
        Static UI previews for proposed affordances. No live wiring — pure
        screenshots / demo.
      </div>

      ${this.renderHeaderStrip()} ${this.renderTodoSection()}
      ${this.renderFollowupSection()} ${this.renderProgressBoardSection()}
    `;
  }

  private renderHeaderStrip(): TemplateResult {
    const CHIPS = [
      { percent: 12, tokens: '24k / 200k' },
      { percent: 72, tokens: '144k / 200k' },
      { percent: 93, tokens: '186k / 200k' },
    ];
    return html`
      <div class="section">
        <div class="section__title">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="bolt"
            variant="solid"
          ></wa-icon>
          Launcher header — YOLO toggle + context utilization
        </div>
        <div class="section__desc">
          Hands-free agent execution toggle and a live context-budget chip,
          shown in the launcher header strip.
        </div>
        <div class="header-strip">
          <span class="header-strip__label">TeXRA</span>
          ${CHIPS.map(
            (c) => html`
              <texra-context-utilization-mock
                percent=${c.percent}
                tokens=${c.tokens}
              ></texra-context-utilization-mock>
            `,
          )}
          <texra-yolo-toggle-mock></texra-yolo-toggle-mock>
        </div>
      </div>
    `;
  }

  private renderTodoSection(): TemplateResult {
    return html`
      <div class="section">
        <div class="section__title">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="list-check"
            variant="solid"
          ></wa-icon>
          Todo list on ProgressBoard
        </div>
        <div class="section__desc">
          Live checklist that shows each step transition Pending → In Progress →
          Completed.
        </div>
        <texra-todo-list-mock></texra-todo-list-mock>
      </div>
    `;
  }

  private renderFollowupSection(): TemplateResult {
    return html`
      <div class="section">
        <div class="section__title">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="comments"
            variant="solid"
          ></wa-icon>
          Followup task controls
        </div>
        <div class="section__desc">
          After a workflow completes, the followup controls let users chat about
          the output or hand it to another agent without re-selecting files.
        </div>
        <texra-followup-controls-mock></texra-followup-controls-mock>
      </div>
    `;
  }

  private renderProgressBoardSection(): TemplateResult {
    return html`
      <div class="section">
        <div class="section__title">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="robot"
            variant="solid"
          ></wa-icon>
          ProgressBoard layout (stream + outputs, no editors)
        </div>
        <div class="section__desc">
          Stream header and live log on the left, the run's output files on the
          right. Editors live in the host, not the board.
        </div>
        <texra-progress-board-layout-mock></texra-progress-board-layout-mock>
      </div>
    `;
  }
}
