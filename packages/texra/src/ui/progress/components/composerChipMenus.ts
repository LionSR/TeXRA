/**
 * The new-task composer's chips: agent, model, approval, and the working
 * directory when there are two or more roots. Each chip is a menu over the
 * launcher's selections; the composer renders them and owns the dispatch.
 * Open on a proposal, the form approves another run's launch, so it offers
 * agent and model only: that run's approval and directory apply.
 */
import { html, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  getModelLabel,
  isModelOptionAvailable,
} from '@texra-ai/harness/schemas';
import { modelRefOf } from '@texra-ai/llm';
import type { AgentOptionData } from '@texra/shared/pickerOptions';
import { isAgentOption } from '@texra/shared/pickerOptions';
import { pickDefaultToolUseAgent } from '@texra/shared/constants/agents';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { IconName } from '@ui/wa/iconNames';
import {
  approvalPolicyLabel,
  formatApprovalPolicy,
} from '@ui/copy/approvalPolicy';
import { TASK_APPROVAL } from '@ui/copy/taskApproval';
import { UNLISTED_AGENT_LABEL } from '@ui/copy/taskAgent';
import { launchPolicy, type ApprovalPolicy } from '@texra-ai/harness/schemas';

export interface ChipMenu {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly title: string;
  readonly description?: string;
  readonly items: TemplateResult;
  readonly onSelect: (value: string) => void;
}

type Launch = Surface['launch'];

/** The launcher's agent in the catalog. No selection (empty) is the default
 *  of the listed agents, the one the host's launch starts
 *  (`prepareSurfaceLaunch`). Imported selections can be bare names; catalog
 *  options are source-qualified. A bare name matches against the effective
 *  catalog, while an explicitly chosen source stays exact. A selection
 *  naming no option (an agent hidden or removed since it was chosen) is no
 *  agent, and the host's launch keeps to the same options: it refuses an
 *  agent hidden since. */
function launchAgentOption(
  launch: Launch,
  host: HostSnapshot,
): AgentOptionData | undefined {
  const agent =
    launch.agent ||
    pickDefaultToolUseAgent(
      host.agentOptions.map(({ label }) => ({ name: label })),
    );
  return host.agentOptions.find((option) => isAgentOption(option.value, agent));
}

/**
 * The model menu over `selected`: its label, and the host's models as items
 * valued `model:<id>`, the selected one checked. A model the host does not
 * list (a saved effort or mode, or a proposal's model) is offered as itself,
 * its effort or mode after the name: `ref@high` is "Name (high)".
 */
export function modelMenu(
  selected: string,
  host: HostSnapshot,
): { readonly label: string; readonly items: TemplateResult } {
  const listed = host.modelOptions.find((option) => option.value === selected);
  const ref = modelRefOf(selected) ?? selected;
  const modifiers = selected.slice(ref.length).replace(/^[@+]/, '');
  const hostOptions = host.modelOptions.map((option) => ({
    value: option.value,
    label: option.label,
    disabled: !isModelOptionAvailable(option),
  }));
  const options = listed
    ? hostOptions
    : [
        {
          value: selected,
          label:
            modifiers === ''
              ? getModelLabel(selected)
              : `${getModelLabel(selected)} (${modifiers})`,
          disabled: false,
        },
        ...hostOptions,
      ];
  return {
    label: listed?.label ?? options[0].label,
    items: html`${repeat(
      options,
      (option) => option.value,
      (option) =>
        html`<wa-dropdown-item
          value=${`model:${option.value}`}
          type="checkbox"
          .checked=${live(option.value === selected)}
          ?disabled=${option.disabled}
          >${option.label}</wa-dropdown-item
        >`,
    )}`,
  };
}

export function launcherChipMenus(
  launch: Launch,
  host: HostSnapshot,
  actions: {
    setLaunch(patch: Partial<Launch>): void;
    openSettings(target: SettingsTarget): void;
  },
  editing: boolean,
): ChipMenu[] {
  const agent = launchAgentOption(launch, host);
  const model = modelMenu(launch.model, host);
  const menus: ChipMenu[] = [
    {
      id: 'composer-agent',
      icon: 'robot',
      label: agent?.label ?? UNLISTED_AGENT_LABEL,
      title: 'Agent',
      items: html`
        ${repeat(
          host.agentOptions,
          (option) => option.value,
          (option) =>
            html`<wa-dropdown-item
              value=${`agent:${option.value}`}
              type="checkbox"
              .checked=${live(option.value === agent?.value)}
              >${option.label}</wa-dropdown-item
            >`,
        )}
        <wa-dropdown-item value="settings:agents"
          >Browse all agents…</wa-dropdown-item
        >
      `,
      onSelect: (value) => {
        if (value.startsWith('agent:')) {
          actions.setLaunch({ agent: value.slice(6) });
        } else if (value === 'settings:agents') {
          actions.openSettings('agents/library');
        }
      },
    },
    {
      id: 'composer-model',
      icon: 'bolt',
      label: model.label,
      title: 'Model',
      items: html`
        ${model.items}
        <wa-dropdown-item value="settings:models"
          >Model settings…</wa-dropdown-item
        >
      `,
      onSelect: (value) => {
        if (value.startsWith('model:')) {
          actions.setLaunch({ model: value.slice(6) });
        } else if (value === 'settings:models') {
          actions.openSettings('models/models');
        }
      },
    },
  ];
  if (editing) return menus;
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
  policy: ApprovalPolicy,
  actions: {
    setLaunch(patch: Partial<Launch>): void;
    openSettings(target: SettingsTarget): void;
  },
): ChipMenu {
  // The task's own Auto-approve, unless the project's Block still wins.
  const overridden =
    launch.approval === 'autoApprove' &&
    launchPolicy(policy, 'autoApprove') !== 'never';
  const policyLabel = approvalPolicyLabel(policy);
  const policyDescription = formatApprovalPolicy(policy);
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
        actions.setLaunch({
          approval: value === 'approval:policy' ? 'policy' : 'autoApprove',
        });
      } else if (value === 'settings:general') {
        actions.openSettings('general/approval');
      }
    },
  };
}
