import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
import type { DiffViewHost } from '@hosts/uiHosts';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';

/** Required desktop capabilities used throughout an agent execution. */
export interface DesktopAgentExecutionHost {
  openPath(filePath: string, line?: number): Promise<void>;
  openBuildDisplay: BuildDisplayFn;
  openDiff: DiffViewHost['openDiff'];
  confirmAcceptFile(message: string): Promise<boolean>;
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Promise<TeamAvailabilityChoice | undefined>;
  signInForRemoteAgentCatalog(): Promise<boolean>;
  showErrorMessage(message: string): Promise<void> | void;
  showInfoMessage(message: string): Promise<void> | void;
  /** Recompute window state derived from a newly completed run. */
  onRunCompleted(): void;
}
