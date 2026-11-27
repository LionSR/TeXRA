/**
 * The new-task composer's chip menu beside its model picker: the working
 * directory, when there are two or more roots. A chip is a menu over the
 * launcher's selections; the composer renders it and owns the dispatch.
 */
import { html, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import type { IconName } from '@ui/wa/iconNames';

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

/** The launcher's chips beside its model: the working directory when there
 *  are two or more roots. */
export function launcherChipMenus(
  launch: Launch,
  host: HostSnapshot,
  actions: { setLaunch(patch: Partial<Launch>): void },
): ChipMenu[] {
  const menus: ChipMenu[] = [];
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
