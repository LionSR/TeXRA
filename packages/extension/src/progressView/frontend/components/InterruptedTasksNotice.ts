/**
 * `<interrupted-tasks-notice>`: the open-time prompt (GUI design 2026-10-02,
 * J5, ruling GQ5), a non-blocking notice above the composer that lists the
 * tasks a closed or crashed TeXRA left interrupted. "Resume all" resumes
 * each; a row opens its task, whose ended line holds that task's one Resume;
 * "Not now" hides the listed tasks until the next open. A task a resume
 * would find blocked says why, with the fix where TeXRA has one: Settings ›
 * Plugins, the one home of the plugin switch and its trust review.
 */
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import type { SessionView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import {
  INTERRUPTED_NOTICE,
  interruptedTasks,
  resumeBlockerFix,
  resumeBlockerLine,
  type InterruptedTask,
} from '@ui/copy/interruptedTasks';
import { bannerStyles, commonViewStyles, designTokens } from '@ui/styles';
import { renderBannerFrame } from '@ui/wa/bannerFrame';
import { waIcon } from '@ui/wa/webAwesomeIcons';

@customElement('interrupted-tasks-notice')
export class InterruptedTasksNotice extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .slot {
        padding-bottom: var(--wa-space-2xs);
      }
      .notice {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
        min-width: 0;
      }
      strong {
        font-weight: var(--font-weight-semibold);
      }
      .notice-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--wa-space-2xs);
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      li {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--wa-space-3xs) var(--wa-space-2xs);
        min-width: 0;
      }
      .task {
        padding: 0;
        border: none;
        background: none;
        font: inherit;
        color: var(--color-text-link);
        cursor: pointer;
        text-align: start;
      }
      .task:hover {
        text-decoration: underline;
      }
      .meta,
      .blocked {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }
      .settings-link {
        margin-inline-start: auto;
        padding: 0;
        border: none;
        background: none;
        font: inherit;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
      }
      .settings-link:hover {
        color: var(--color-text-link);
      }
    `,
  ];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;

  private resumeAll(tasks: readonly InterruptedTask[]): void {
    for (const task of tasks)
      this.dispatchEvent(
        SessionUiEvents.host({ kind: 'resume', runId: task.runId }),
      );
  }

  private dismiss(tasks: readonly InterruptedTask[]): void {
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'dismissInterrupted',
        runIds: tasks.map((task) => task.runId),
      }),
    );
  }

  private openSettings(section: 'plugins' | 'general'): void {
    this.dispatchEvent(SessionUiEvents.host({ kind: 'openSettings', section }));
  }

  private renderTask(task: InterruptedTask): TemplateResult {
    const fix = task.blocked && resumeBlockerFix(task.blocked);
    return html`<li>
      <button
        type="button"
        class="task"
        @click=${() =>
          this.dispatchEvent(
            SessionUiEvents.surface({ kind: 'select', runId: task.runId }),
          )}
      >
        ${task.title}
      </button>
      <span class="meta"
        >${
          task.stoppedAt === null
            ? nothing
            : html`stopped
                <wa-relative-time
                  .date=${new Date(task.stoppedAt)}
                  format="narrow"
                ></wa-relative-time>`
        }${task.agents ? ` · ${task.agents}` : nothing}</span
      >
      ${
        task.blocked
          ? html`<span class="blocked"
                >· ${resumeBlockerLine(task.blocked)}</span
              >${
                fix
                  ? html`<wa-button
                      appearance="outlined"
                      size="s"
                      @click=${() => this.openSettings('plugins')}
                      >${fix}</wa-button
                    >`
                  : nothing
              }`
          : nothing
      }
    </li>`;
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.view) return nothing;
    const tasks = interruptedTasks(
      this.view,
      this.surface?.interruptedDismissed,
    );
    if (tasks.length === 0) return nothing;
    const notice = renderBannerFrame({
      id: 'interruptedTasksNotice',
      variant: 'neutral',
      icon: 'clock-rotate-left',
      role: 'status',
      body: html`<div class="notice">
        <strong>${INTERRUPTED_NOTICE.heading(tasks.length)}</strong>
        <ul>
          ${repeat(
            tasks,
            (task) => task.runId,
            (task) => this.renderTask(task),
          )}
        </ul>
        <div class="notice-actions">
          <wa-button
            id="resumeAllButton"
            variant="brand"
            size="s"
            @click=${() => this.resumeAll(tasks)}
            >${waIcon('forward-step', { slot: 'start' })}${
              INTERRUPTED_NOTICE.resumeAll
            }</wa-button
          >
          <wa-button
            id="notNowButton"
            appearance="plain"
            size="s"
            @click=${() => this.dismiss(tasks)}
            >${INTERRUPTED_NOTICE.notNow}</wa-button
          >
          <button
            type="button"
            class="settings-link"
            @click=${() => this.openSettings('general')}
          >
            ${INTERRUPTED_NOTICE.alwaysResume}
          </button>
        </div>
      </div>`,
    });
    return html`<div class="slot">${notice}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'interrupted-tasks-notice': InterruptedTasksNotice;
  }
}
