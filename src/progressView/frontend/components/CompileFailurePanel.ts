// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  STREAM_STATUS,
  type CompileFailure,
  type StreamStatus,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - progress view
import { ProgressEvents } from '../events';

@customElement('compile-failure-panel')
export class CompileFailurePanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    css`
      :host {
        display: block;
      }

      .compile-panel {
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--spacing-small) 0;
        color: var(--color-text-secondary);
      }

      .compile-panel__header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-bottom: var(--spacing-small);
      }

      .compile-panel__title {
        color: var(--color-text);
        font-weight: var(--font-weight-medium);
      }

      .compile-panel__body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
      }

      .compile-panel__description {
        line-height: 1.4;
      }

      .compile-panel__row {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        min-width: 0;
      }

      .compile-panel__file {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .compile-panel__actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-small);
      }

      @media (max-width: 500px) {
        .compile-panel__row,
        .compile-panel__actions {
          flex-wrap: wrap;
        }
      }
    `,
  ];

  @property({ attribute: false }) failuresByRound: Record<
    string,
    CompileFailure[]
  > = {};
  @property({ attribute: false }) status: StreamStatus | null = null;

  override render(): TemplateResult | typeof nothing {
    const failures = this.getFailures();
    if (failures.length === 0) return nothing;
    const canRunFixer = this.canRunFixer();

    return html`
      <div class="compile-panel" role="region" aria-label="Compile failures">
        <div class="compile-panel__header">
          <i class="codicon codicon-warning" aria-hidden="true"></i>
          <span class="compile-panel__title"
            >Compile check needs attention</span
          >
        </div>
        <div class="compile-panel__body">
          <div class="compile-panel__description">
            The generated output stayed in task-run storage, but LaTeX did not
            build it. Open the log to inspect it, or launch latexFixer with this
            context.
          </div>
          ${repeat(
            failures,
            (failure) => `${failure.round}:${failure.log.absolutePath}`,
            (failure) => this.renderFailure(failure),
          )}
          <div class="compile-panel__actions">
            <vscode-button
              appearance="primary"
              ?disabled=${!canRunFixer}
              title=${canRunFixer
                ? 'Run latexFixer'
                : 'Wait for the workflow run to finish before launching latexFixer'}
              @click=${this.runLatexFixer}
            >
              <span slot="start" class="codicon codicon-tools"></span>
              Run latexFixer
            </vscode-button>
          </div>
        </div>
      </div>
    `;
  }

  private renderFailure(failure: CompileFailure): TemplateResult {
    return html`
      <div class="compile-panel__row">
        <span
          class="compile-panel__file"
          title=${`${failure.displayName} - ${failure.logRelativePath}`}
        >
          r${failure.round}: ${failure.displayName}
        </span>
        <vscode-button
          appearance="secondary"
          data-file=${failure.log.absolutePath}
          @click=${this.openLog}
        >
          <span slot="start" class="codicon codicon-output"></span>
          Open log
        </vscode-button>
      </div>
    `;
  }

  private getFailures(): CompileFailure[] {
    return Object.entries(this.failuresByRound)
      .flatMap(([, failures]) => failures)
      .filter(Boolean);
  }

  private canRunFixer(): boolean {
    return (
      this.status == null ||
      this.status === STREAM_STATUS.READY ||
      this.status === STREAM_STATUS.ERROR ||
      this.status === STREAM_STATUS.STOPPED
    );
  }

  private openLog(event: Event): void {
    const target = event.currentTarget as HTMLElement | null;
    const file = target?.dataset.file;
    if (!file) return;
    this.dispatchEvent(
      ProgressEvents.fileAction({
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file,
      }),
    );
  }

  private runLatexFixer(): void {
    if (!this.canRunFixer()) return;
    this.dispatchEvent(ProgressEvents.compileFixerRun());
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'compile-failure-panel': CompileFailurePanel;
  }
}
