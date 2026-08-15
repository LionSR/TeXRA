import { computeAgentOptionsData } from '@agent/index';
import { createLog } from '@logger/logUtils';
import {
  buildVisibleBasicModelOptionsData,
  computeModelOptionsData,
} from '@model/computeModelOptions';
import type { AgentProposalPermission } from '@shared/schemas';
import { AgentCategory, agentName } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { WebviewUpdater } from './WebviewUpdater';

const log = createLog('agentProposalTransport');

/**
 * Show/dismiss transport for agent proposals, shared by every host that renders
 * the proposal card with model and agent dropdowns.
 *
 * The card is shown twice: immediately with the static visible-model list so it
 * appears without waiting on the network, then again once the full option data
 * resolves. `isPending` guards the RESOLVE-between-two-SHOWs race: if the user
 * approves or rejects while options are loading, the proposal is gone from the
 * handler and the late SHOW would re-create an undismissable ghost card.
 */
export function createAgentProposalTransport(options: {
  /** Read lazily: hosts wire this before their backend field is assigned. */
  getWebviewUpdater(): WebviewUpdater;
  isPending(proposalId: string): boolean;
}): {
  show(proposal: AgentProposalPermission): void;
  dismiss(proposalId: string): void;
} {
  const { getWebviewUpdater, isPending } = options;

  // Model options have a visible-model fallback that does not require
  // ServerSideKeyService, so the dropdown still appears if availability
  // loading fails. Agent options have no static equivalent, so the agent
  // dropdown is omitted when the registry fetch fails.
  const sendResolvedOptions = async (
    proposal: AgentProposalPermission,
  ): Promise<void> => {
    const isWorkflow = proposal.agentCategory === AgentCategory.Workflow;
    const loadAgentOptions = async () => {
      const all = await computeAgentOptionsData();
      const raw = isWorkflow ? all.workflow : all.toolUse;
      // proposal.agent is a plain name, so keep identity separate from label.
      return raw.map((option) => ({
        ...option,
        value: agentName(option.value),
      }));
    };
    const [modelOptionsData, agentOptionsData] = await Promise.all([
      computeModelOptionsData().catch((error) => {
        log.debug(
          `Model options fetch failed; falling back to the static visible-model list: ${toErrorMessage(error)}`,
        );
        return buildVisibleBasicModelOptionsData();
      }),
      loadAgentOptions().catch((error) => {
        log.debug(
          `Agent options fetch failed; omitting the agent dropdown: ${toErrorMessage(error)}`,
        );
        return undefined;
      }),
    ]);
    if (!isPending(proposal.proposalId)) return;
    getWebviewUpdater().showPermission({
      kind: PERMISSION_KIND.PROPOSAL,
      data: proposal,
      modelOptionsData,
      agentOptionsData,
    });
  };

  return {
    show(proposal) {
      getWebviewUpdater().showPermission({
        kind: PERMISSION_KIND.PROPOSAL,
        data: proposal,
        modelOptionsData: buildVisibleBasicModelOptionsData(),
      });
      void sendResolvedOptions(proposal);
    },
    dismiss(proposalId) {
      getWebviewUpdater().resolvePermission(
        PERMISSION_KIND.PROPOSAL,
        proposalId,
      );
    },
  };
}
