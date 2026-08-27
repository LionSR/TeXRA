export interface DesktopWorkspaceRelaunchHandoff {
  supervised: boolean;
  send?: (args: string[]) => void;
  relaunch(args: string[]): void;
}

function handoffDesktopWorkspaceRelaunch(
  args: string[],
  handoff: DesktopWorkspaceRelaunchHandoff,
): void {
  if (handoff.supervised && handoff.send) {
    handoff.send(args);
    return;
  }
  handoff.relaunch(args);
}

export function handoffDesktopWorkspaceRelaunchFromMainProcess(
  args: string[],
  handoff: DesktopWorkspaceRelaunchHandoff,
): void {
  handoffDesktopWorkspaceRelaunch(args, handoff);
}
