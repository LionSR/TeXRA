import { html, nothing, type TemplateResult } from 'lit';

import { waIcon } from '@shared/wa/webAwesomeIcons';

import { workspaceName, type WorkbenchTab } from '../shared/desktopTaskShell';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  type DesktopEnvironmentSummary,
} from '../shared/desktopWorkspaceMessages';

interface EnvironmentPopoverDeps {
  getWorkbenchTabs(): readonly WorkbenchTab[];
  getChildStreamCount(): number;
  postMessage(command: string, payload?: Record<string, unknown>): void;
}

interface EnvironmentPopoverController {
  template(workspacePath: string | undefined): TemplateResult;
  set(summary: DesktopEnvironmentSummary | undefined, loading: boolean): void;
  close(): void;
}

export function createEnvironmentPopover({
  getWorkbenchTabs,
  getChildStreamCount,
  postMessage,
}: EnvironmentPopoverDeps): EnvironmentPopoverController {
  let environmentSummary: DesktopEnvironmentSummary | undefined;
  let environmentLoading = false;
  let environmentPopoverOpen = false;

  function environmentPopoverTemplate(
    workspacePath: string | undefined,
  ): TemplateResult {
    const childCount = getChildStreamCount();
    const terminalCount = getWorkbenchTabs().filter(
      (tab) => tab.kind === 'terminal',
    ).length;
    const sources = getWorkbenchTabs().filter(
      (tab) => tab.kind === 'editor' && tab.target,
    );
    const branchLabel =
      environmentSummary?.branch ?? (environmentLoading ? 'Loading…' : 'Local');
    const changedFiles = environmentSummary?.changedFiles ?? 0;

    return html`
      <wa-popover
        class="task-environment-popover"
        for="taskEnvironmentButton"
        placement="bottom-end"
        distance="6"
        without-arrow
        .open=${environmentPopoverOpen}
        @wa-show=${handleEnvironmentPopoverShow}
        @wa-hide=${handleEnvironmentPopoverHide}
      >
        <div class="task-environment-heading">
          <span>Environment</span>
          <wa-button
            type="button"
            class="task-environment-refresh icon-button is-size-m"
            appearance="plain"
            size="s"
            aria-label="Refresh environment"
            title="Refresh environment"
            ?disabled=${environmentLoading}
            @click=${requestEnvironmentSummary}
          >
            ${waIcon(environmentLoading ? 'spinner' : 'rotate-right')}
          </wa-button>
        </div>
        <div class="task-environment-section">
          <div class="task-environment-row">
            <span class="task-environment-row-icon"
              >${waIcon('plus-minus')}</span
            >
            <span>Changes</span>
            <span class="task-environment-trailing task-environment-diff">
              <span class="is-added"
                >+${environmentSummary?.additions ?? 0}</span
              >
              <span class="is-deleted"
                >-${environmentSummary?.deletions ?? 0}</span
              >
            </span>
          </div>
          <div class="task-environment-row">
            <span class="task-environment-row-icon"
              >${waIcon('folder-open')}</span
            >
            <span title=${workspacePath ?? ''}
              >${workspaceName(workspacePath)}</span
            >
            <span class="task-environment-trailing">
              ${changedFiles} changed
            </span>
          </div>
          <div class="task-environment-row">
            <span class="task-environment-row-icon"
              >${waIcon('code-branch')}</span
            >
            <span title=${branchLabel}>${branchLabel}</span>
            ${environmentSyncTemplate(environmentSummary)}
          </div>
          <div class="task-environment-row">
            <span class="task-environment-row-icon"
              >${waIcon('circle-dot')}</span
            >
            <span>Commit or push</span>
            <span class="task-environment-trailing">
              ${changedFiles === 0 ? 'Clean' : `${changedFiles} pending`}
            </span>
          </div>
        </div>

        <div class="task-environment-section">
          <div class="task-environment-section-title">Agents</div>
          <div class="task-environment-row">
            <span class="task-environment-row-icon">${waIcon('users')}</span>
            <span>Subagents</span>
            <span class="task-environment-trailing">
              ${childCount === 0 ? 'None' : `${childCount} active or completed`}
            </span>
          </div>
        </div>

        <div class="task-environment-section">
          <div class="task-environment-section-title">Background processes</div>
          <div class="task-environment-row">
            <span class="task-environment-row-icon">${waIcon('terminal')}</span>
            <span>Background terminal</span>
            <span class="task-environment-trailing">
              ${terminalCount === 0 ? 'None' : terminalCount}
            </span>
          </div>
        </div>

        <div class="task-environment-section">
          <div class="task-environment-section-title">Sources</div>
          ${
            sources.length === 0
              ? html`
                  <div class="task-environment-row is-muted">
                    <span class="task-environment-row-icon">
                      ${waIcon('link')}
                    </span>
                    <span>No open sources</span>
                  </div>
                `
              : sources.slice(0, 3).map(
                  (source) => html`
                    <div class="task-environment-row">
                      <span class="task-environment-row-icon">
                        ${waIcon('file-code')}
                      </span>
                      <span title=${source.target ?? ''}>${source.title}</span>
                    </div>
                  `,
                )
          }
          ${
            sources.length > 3
              ? html`
                  <div class="task-environment-more">
                    +${sources.length - 3} more
                  </div>
                `
              : nothing
          }
        </div>
      </wa-popover>
    `;
  }

  function environmentSyncTemplate(
    summary: DesktopEnvironmentSummary | undefined,
  ): TemplateResult {
    if (!summary?.upstream) {
      return html`
        <span class="task-environment-trailing is-muted">No upstream</span>
      `;
    }
    if (summary.ahead === 0 && summary.behind === 0) {
      return html`
        <span class="task-environment-trailing is-success">
          ${waIcon('circle-check')} Synced
        </span>
      `;
    }
    // The arrow icons are aria-hidden (decorative, see waIcon()), so role="img"
    // gives this aria-label a host to announce words ("3 ahead, 2 behind")
    // instead of the bare counts next to them.
    const syncLabel = [
      summary.ahead > 0 ? `${summary.ahead} ahead` : '',
      summary.behind > 0 ? `${summary.behind} behind` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return html`
      <span
        class="task-environment-trailing"
        role="img"
        aria-label=${syncLabel}
      >
        ${
          summary.ahead > 0
            ? html`${waIcon('arrow-up')}${summary.ahead}`
            : nothing
        }
        ${
          summary.behind > 0
            ? html`${waIcon('arrow-down')}${summary.behind}`
            : nothing
        }
      </span>
    `;
  }

  function handleEnvironmentPopoverShow(): void {
    environmentPopoverOpen = true;
    requestEnvironmentSummary();
  }

  function handleEnvironmentPopoverHide(): void {
    environmentPopoverOpen = false;
  }

  function requestEnvironmentSummary(): void {
    if (environmentLoading) return;
    environmentLoading = true;
    postMessage(DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST);
  }

  return {
    template: environmentPopoverTemplate,
    set(summary, loading) {
      environmentSummary = summary;
      environmentLoading = loading;
    },
    close() {
      environmentPopoverOpen = false;
    },
  };
}
