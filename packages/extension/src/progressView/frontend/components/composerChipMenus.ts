/**
 * The new-task composer's chips: agent, model, approval, and the working
 * directory when there are two or more roots. Each chip is a menu over the
 * launcher's selections; the composer renders them and owns the dispatch.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  agentName,
  isModelOptionAvailable,
  type AgentOptionData,
  type SessionType,
} from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { Surface } from '@shared/session/surface';
import type { TeXRAIconName } from '@shared/iconNames';
import {
  texraApprovalPolicyLabel,
  formatTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { TASK_APPROVAL } from '@ui/copy/taskApproval';

/** The agent menu's sections, one per launch mode: every agent chats, and
 *  an agent with a document task (`rounds`) also runs one. */
const AGENT_SECTIONS: ReadonlyArray<
  readonly [SessionType, string, (option: AgentOptionData) => boolean]
> = [
  ['chat', 'Chat', () => true],
  ['task', 'Document task', (option) => option.rounds !== undefined],
];

export interface ChipMenu {
  readonly id: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title: string;
  readonly description?: string;
  readonly items: TemplateResult;
  readonly onSelect: (value: string) => void;
}

type Launch = Surface['launch'];

export function launcherChipMenus(
  launch: Launch,
  host: HostSnapshot,
  actions: {
    setLaunch(patch: Partial<Launch>): void;
    openSettings(section: 'agents' | 'teams' | 'models' | 'general'): void;
  },
): ChipMenu[] {
  const team = host.teamOptions.find(
    (option) => option.value === launch.selectedTeamId,
  );
  // The default and imported selections can be bare names; catalog options
  // are source-qualified. Match a bare name against the effective catalog,
  // while keeping an explicitly chosen source exact.
  const name = agentName(launch.agent);
  const agent = host.agentOptions.find(
    (option) =>
      option.value === launch.agent ||
      (name === launch.agent && agentName(option.value) === name),
  );
  const agentLabel =
    launch.launchTarget === 'team' && team
      ? team.label
      : (agent?.label ?? launch.agent);
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
        ${AGENT_SECTIONS.map(([sessionType, heading, offers]) => {
          const agents = host.agentOptions.filter(offers);
          if (agents.length === 0) return nothing;
          return html`<div class="menu-heading">${heading}</div>
            ${repeat(
              agents,
              (option) => option.value,
              (option) =>
                html`<wa-dropdown-item
                  value=${`agent:${sessionType}:${option.value}`}
                  type="checkbox"
                  .checked=${live(
                    launch.launchTarget === 'agent' &&
                      launch.sessionType === sessionType &&
                      option.value === agent?.value,
                  )}
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
                      .checked=${live(
                        launch.launchTarget === 'team' &&
                          option.value === launch.selectedTeamId,
                      )}
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
        const agent = /^agent:(chat|task):(.+)$/.exec(value);
        if (agent) {
          actions.setLaunch({
            sessionType: agent[1] as SessionType,
            agent: agent[2],
          });
        } else if (value.startsWith('team:')) {
          // A team runs its lead as a chat.
          actions.setLaunch({
            launchTarget: 'team',
            sessionType: 'chat',
            selectedTeamId: value.slice(5),
          });
        } else if (value === 'settings:teams') {
          actions.openSettings('teams');
        } else if (value === 'settings:agents') {
          actions.openSettings('agents');
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
              .checked=${live(option.value === launch.model)}
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
  menus.push(approvalMenu(launch, host.approvalPolicy, actions));
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
            .checked=${live(option.value === launch.workingDirectory)}
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
  policy: TexraApprovalPolicy,
  actions: {
    setLaunch(patch: Partial<Launch>): void;
    openSettings(section: 'general'): void;
  },
): ChipMenu {
  const overridden = launch.approval === 'autoApprove' && policy !== 'never';
  const policyLabel = texraApprovalPolicyLabel(policy);
  const policyDescription = formatTexraApprovalPolicy(policy);
  return {
    id: 'composer-approval',
    icon: overridden ? 'rocket' : 'shield',
    label: overridden ? TASK_APPROVAL.autoApprove.label : policyLabel,
    title: TASK_APPROVAL.title,
    description: overridden
      ? TASK_APPROVAL.autoApprove.description
      : policyDescription,
    items: html`
      <wa-dropdown-item
        value="approval:policy"
        type="checkbox"
        .checked=${live(!overridden)}
        ><span class="menu-choice"
          ><span>Use settings · ${policyLabel}</span>
          <small>${policyDescription}</small></span
        ></wa-dropdown-item
      >
      <wa-dropdown-item
        value="approval:autoApprove"
        type="checkbox"
        .checked=${live(overridden)}
        ?disabled=${policy === 'never'}
        ><span class="menu-choice"
          ><span>Auto-approve this task</span>
          <small
            >${
              policy === 'never'
                ? 'Blocked by your approval settings.'
                : 'Allow file edits, commands and agent work without asking.'
            }</small
          ></span
        ></wa-dropdown-item
      >
      <wa-dropdown-item value="settings:general"
        >Open settings…</wa-dropdown-item
      >
    `,
    onSelect: (value) => {
      if (value === 'approval:policy' || value === 'approval:autoApprove') {
        if (value === 'approval:autoApprove' && policy === 'never') return;
        actions.setLaunch({ approval: value.slice(9) as Launch['approval'] });
      } else if (value === 'settings:general') {
        actions.openSettings('general');
      }
    },
  };
}
