// Local imports - shared schemas
import type { TaskGroup } from '@shared/schemas';

type GroupElements = Map<string, HTMLElement>;

export function collapseGroupTree(
  groupId: string,
  taskGroups: Map<string, TaskGroup>,
  onCollapse: (id: string) => void,
): void {
  for (const [childId, group] of taskGroups.entries()) {
    if (group.parentGroupId === groupId) {
      collapseGroupTree(childId, taskGroups, onCollapse);
    }
  }

  onCollapse(groupId);
}

export function findActiveGroupId(
  currentGroupId: string | null,
  taskGroups: Map<string, TaskGroup>,
  groupElements: GroupElements,
): string | null {
  const current = currentGroupId ? taskGroups.get(currentGroupId) : undefined;
  if (current) return current.id;

  let latestGroup: string | null = null;
  let latestTime = 0;
  for (const [id, element] of groupElements.entries()) {
    const group = taskGroups.get(id);
    if (!group) continue;

    const isRootGroup = !group.parentGroupId;
    const isVisible = isRootGroup
      ? !element.hidden
      : element instanceof HTMLDetailsElement && element.open === true;
    if (!isVisible) continue;

    if (group.startTime > latestTime) {
      latestGroup = id;
      latestTime = group.startTime;
    }
  }

  return latestGroup;
}
