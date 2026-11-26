/**
 * The new-task composer's chip menus beside its model picker: approval, and
 * the working directory when there are two or more roots. Each chip is a
 * menu over the launcher's selections; the composer renders them and owns
 * the dispatch. A card that offers a model as a plain menu reads it here.
 */
import { html, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import { joinFacts } from '@texra-ai/worldline/schemas';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { IconName } from '@ui/wa/iconNames';
import {
  approvalPolicyLabel,
  formatApprovalPolicy,
} from '@ui/copy/approvalPolicy';
import { TASK_APPROVAL } from '@ui/copy/taskApproval';
import { modelChoices } from './ModelPicker';
import { launchPolicy, type ApprovalPolicy } from '@texra-ai/worldline/schemas';

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

/**
 * The model menu over `selected`, for a card that offers the model as a
 * plain menu: its label, and the choices as items valued `model:<id>`, the
 * selected one checked (`modelChoices`).
 */
export function modelMenu(
  selected: string,
  host: HostSnapshot,
): { readonly label: string; readonly items: TemplateResult } {
  const { current, choices } = modelChoices(selected, host.modelOptions);
  return {
    label: current.label,
    items: html`${repeat(
      choices,
      (choice) => choice.value,
      (choice) =>
        html`<wa-dropdown-item
          value=${`model:${choice.value}`}
          type="checkbox"
          .checked=${live(choice.value === selected)}
          ?disabled=${choice.disabled}
          >${choice.label}</wa-dropdown-item
        >`,
    )}`,
  };
}

/** The launcher's chips beside its model: approval, and the working
 *  directory when there are two or more roots. */
export function launcherChipMenus(
  launch: Launch,
  host: HostSnapshot,
  actions: {
    setLaunch(patch: Partial<Launch>): void;
    openSettings(target: SettingsTarget): void;
  },
): ChipMenu[] {
  const menus: ChipMenu[] = [];
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

/** Approval sits beside the model because it is chosen per task, at
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
          ><span>${joinFacts(['Use settings', policyLabel])}</span>
          <small>${policyDescription}</small></span
        ></wa-dropdown-item
      >
      <wa-dropdown-item
        value="approval:autoApprove"
        type="checkbox"
        .checked=${live(overridden)}
        ?disabled=${policy === 'never'}
        ><span class="menu-choice"
          ><span>${TASK_APPROVAL.autoApprove.menuLabel}</span>
          <small
            >${
              policy === 'never'
                ? TASK_APPROVAL.autoApprove.blocked
                : TASK_APPROVAL.autoApprove.menuDescription
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
