/**
 * The new-task composer's chips: agent, model, approval, and the working
 * directory when there are two or more roots. Each chip is a menu over the
 * launcher's selections; the composer renders them and owns the dispatch.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import { isModelOptionAvailable, type SessionType } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { Surface } from '@shared/session/surface';
import { TASK_APPROVAL } from '@ui/copy/taskApproval';
import type { TeXRAIconName } from '@ui/wa/iconNames';

/** The agent menu's sections: the category an agent belongs to is the run
 *  type its launch takes. */
const AGENT_SECTIONS: ReadonlyArray<readonly [SessionType, string]> = [
  ['toolUse', 'Interactive'],
  ['workflow', 'Document passes'],
];

export interface ChipMenu {
  readonly id: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title: string;
  readonly items: TemplateResult;
  readonly onSelect: (value: string) => void;
}

type Launch = Surface['launch'];

export function launcherChipMenus(
  launch: Launch,
  host: HostSnapshot,
  actions: {
    setLaunch(patch: Partial<Launch>): void;
    openSettings(
      section: 'agents' | 'teams' | 'models',
      sessionType?: SessionType,
    ): void;
  },
): ChipMenu[] {
  const team = host.teamOptions.find(
    (option) => option.value === launch.selectedTeamId,
  );
  const agentLabel =
    launch.launchTarget === 'team' && team
      ? team.label
      : (host.agentOptions[launch.sessionType]?.find(
          (option) => option.value === launch.agent,
        )?.label ?? launch.agent);
  const model = host.modelOptions.find(
    (option) => option.value === launch.model,
  );
  const menus: ChipMenu[] = [
    {
      id: 'composer-agent',
      icon: 'robot',
      label: agentLabel,
      title: 'Agent',
      items: html`
        ${AGENT_SECTIONS.map(([category, heading]) => {
          const agents = host.agentOptions[category] ?? [];
          if (agents.length === 0) return nothing;
          return html`<div class="menu-heading">${heading}</div>
            ${repeat(
              agents,
              (option) => option.value,
              (option) =>
                html`<wa-dropdown-item
                  value=${`agent:${category}:${option.value}`}
                  type="checkbox"
                  ?checked=${
                    launch.launchTarget === 'agent' &&
                    launch.sessionType === category &&
                    option.value === launch.agent
                  }
                  >${option.label}</wa-dropdown-item
                >`,
            )}`;
        })}
        ${
          host.teamOptions.length > 0
            ? html`<div class="menu-heading">Teams</div>
                ${repeat(
                  host.teamOptions,
                  (option) => option.value,
                  (option) =>
                    html`<wa-dropdown-item
                      value=${`team:${option.value}`}
                      type="checkbox"
                      ?checked=${
                        launch.launchTarget === 'team' &&
                        option.value === launch.selectedTeamId
                      }
                      >${option.label}</wa-dropdown-item
                    >`,
                )}
                <wa-dropdown-item value="settings:teams"
                  >Manage teams…</wa-dropdown-item
                >`
            : nothing
        }
        <wa-dropdown-item value="settings:agents"
          >Browse all agents…</wa-dropdown-item
        >
      `,
      onSelect: (value) => {
        const agent = /^agent:(toolUse|workflow):(.+)$/.exec(value);
        if (agent) {
          actions.setLaunch({
            sessionType: agent[1] as SessionType,
            agent: agent[2],
          });
        } else if (value.startsWith('team:')) {
          // A team runs its lead as an interactive session.
          actions.setLaunch({
            launchTarget: 'team',
            sessionType: 'toolUse',
            selectedTeamId: value.slice(5),
          });
        } else if (value === 'settings:teams') {
          actions.openSettings('teams');
        } else if (value === 'settings:agents') {
          actions.openSettings('agents', launch.sessionType);
        }
      },
    },
    {
      id: 'composer-model',
      icon: 'bolt',
      label: model?.label ?? launch.model,
      title: 'Model',
      items: html`
        ${repeat(
          host.modelOptions,
          (option) => option.value,
          (option) =>
            html`<wa-dropdown-item
              value=${`model:${option.value}`}
              type="checkbox"
              ?checked=${option.value === launch.model}
              ?disabled=${!isModelOptionAvailable(option)}
              >${option.label}</wa-dropdown-item
            >`,
        )}
        <wa-dropdown-item value="settings:models"
          >Model settings…</wa-dropdown-item
        >
      `,
      onSelect: (value) => {
        if (value.startsWith('model:')) {
          actions.setLaunch({ model: value.slice(6) });
        } else if (value === 'settings:models') {
          actions.openSettings('models');
        }
      },
    },
  ];
  menus.push(approvalMenu(launch, actions.setLaunch));
  if (host.workspaceRoots.length >= 2) {
    const root = host.workspaceRoots.find(
      (option) => option.value === launch.workingDirectory,
    );
    menus.push({
      id: 'composer-root',
      icon: 'folder-open',
      label: root?.label ?? host.workspaceRoots[0].label,
      title: 'Working directory',
      items: html`${repeat(
        host.workspaceRoots,
        (option) => option.value,
        (option) =>
          html`<wa-dropdown-item
            value=${`root:${option.value}`}
            type="checkbox"
            ?checked=${option.value === launch.workingDirectory}
            >${option.label}</wa-dropdown-item
          >`,
      )}`,
      onSelect: (value) => {
        if (value.startsWith('root:')) {
          actions.setLaunch({ workingDirectory: value.slice(5) });
        }
      },
    });
  }
  return menus;
}

/** Approval sits beside agent and model because it is chosen per task, at
 *  the moment of delegating; the run header then shows it and can revoke it. */
function approvalMenu(
  launch: Launch,
  setLaunch: (patch: Partial<Launch>) => void,
): ChipMenu {
  const choices = ['policy', 'autoApprove'] as const;
  return {
    id: 'composer-approval',
    icon: launch.approval === 'autoApprove' ? 'rocket' : 'shield',
    label: TASK_APPROVAL[launch.approval].label,
    title: TASK_APPROVAL.title,
    items: html`${choices.map(
      (choice) =>
        html`<wa-dropdown-item
          value=${`approval:${choice}`}
          type="checkbox"
          title=${TASK_APPROVAL[choice].description}
          ?checked=${launch.approval === choice}
          >${TASK_APPROVAL[choice].label}<span slot="details"
            >${TASK_APPROVAL[choice].detail}</span
          ></wa-dropdown-item
        >`,
    )}`,
    onSelect: (value) => {
      if (value === 'approval:policy' || value === 'approval:autoApprove') {
        setLaunch({ approval: value.slice(9) as Launch['approval'] });
      }
    },
  };
}
