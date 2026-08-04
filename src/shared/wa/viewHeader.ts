import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

import { waIcon } from './webAwesomeIcons';
import type { TeXRAIconName } from './iconNames';
import type { WaTabShowEvent } from './tabs';
import './tabs';

type ViewHeaderClickHandler = (event: Event) => void;

interface ViewHeaderOptions {
  active: 'launcher' | 'progress';
  dashboardButtonId: string;
  launcherTab?: {
    focusSidebar?: boolean;
    title?: string;
    onClick?: ViewHeaderClickHandler;
  };
  onOpenDashboard: ViewHeaderClickHandler;
  onTabShow: (event: WaTabShowEvent) => void;
  secondaryAction: HeaderAction;
}

interface HeaderAction {
  id: string;
  label: string;
  icon: TeXRAIconName;
  onClick: ViewHeaderClickHandler;
}

export function renderViewHeader({
  active,
  dashboardButtonId,
  launcherTab,
  onOpenDashboard,
  onTabShow,
  secondaryAction,
}: ViewHeaderOptions): TemplateResult {
  return html`
    <div class="view-header">
      <wa-tab-group
        class="view-tabs"
        .active=${active}
        without-scroll-controls
        @wa-tab-show=${onTabShow}
      >
        <wa-tab
          panel="launcher"
          class=${ifDefined(
            launcherTab?.focusSidebar === true
              ? 'focus-sidebar-tab'
              : undefined,
          )}
          title=${ifDefined(launcherTab?.title)}
          @click=${launcherTab?.onClick}
        >
          ${waIcon('pencil')} New
        </wa-tab>
        <wa-tab panel="progress"> ${waIcon('robot')} Sessions </wa-tab>
        <wa-tab-panel name="launcher"></wa-tab-panel>
        <wa-tab-panel name="progress"></wa-tab-panel>
      </wa-tab-group>

      ${renderHeaderAction({
        id: dashboardButtonId,
        label: 'Open dashboard',
        icon: 'gear',
        onClick: onOpenDashboard,
      })}
      ${renderHeaderAction(secondaryAction)}
    </div>
  `;
}

function renderHeaderAction({
  id,
  label,
  icon,
  onClick,
}: HeaderAction): TemplateResult {
  return html`<wa-button
      id=${id}
      class="header-action"
      aria-label=${label}
      appearance="plain"
      size="s"
      @click=${onClick}
    >
      ${waIcon(icon)}
    </wa-button>
    <wa-tooltip for=${id}> ${label} </wa-tooltip>`;
}
