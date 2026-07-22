import { loadTeamOptions } from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import type { TeamOptionData } from '@shared/schemas';

export function loadMainViewTeamOptions(): Promise<TeamOptionData[]> {
  return loadTeamOptions(createTeamCatalogPorts());
}
