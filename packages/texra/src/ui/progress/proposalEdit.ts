/**
 * A proposal card's Edit: the launch form opened on an agent's proposal.
 * What it opens with (the proposal as it would launch), and what its Send
 * answers (an approval carrying the form's changes).
 */
import {
  type RequestDecision,
  type RunView,
  type SessionView,
} from '@texra-ai/worldline/schemas';
import type { Surface, SurfaceAction } from '@texra/shared/session/surface';

type Launch = Surface['launch'];
/** An agent proposal as the view holds it. */
type AgentProposalRequest = Extract<
  SessionView['requests'][number]['payload'],
  { kind: 'proposal' }
>['data'];
type LaunchPatch = Extract<SurfaceAction, { kind: 'launch' }>['patch'];

/** The proposal the surface's form is open on, and the run asking. */
export function editedProposal(
  surface: Surface,
  view: SessionView,
): { readonly data: AgentProposalRequest; readonly run?: RunView } | null {
  const editing = surface.shown;
  if (editing._tag !== 'Proposal') return null;
  const request = view.requests.find(
    ({ runId, requestId }) =>
      runId === editing.runId && requestId === editing.requestId,
  );
  if (request?.payload.kind !== 'proposal') return null;
  return { data: request.payload.data, run: view.runs.get(editing.runId) };
}

/** The launch form filled with what the proposal would launch. */
export function proposalLaunchPatch(data: AgentProposalRequest): LaunchPatch {
  return {
    // As proposed, effort and mode included: the model menu offers a
    // model it does not list as itself.
    model: data.model,
    instruction: data.instruction,
    inputFiles: [...data.inputFiles],
    contextFiles: [...data.contextFiles],
    mediaFiles: [...data.mediaFiles],
  };
}

/** The approval the form's Send answers: the proposal with the form's
 *  model when it differs, and its instruction and files, which the run
 *  compares with the proposal. */
export function proposalApproval(
  data: AgentProposalRequest,
  launch: Launch,
): Extract<RequestDecision, { action: 'approve' }> {
  return {
    action: 'approve',
    edit: {
      kind: 'proposal',
      ...(launch.model !== data.model && { model: launch.model }),
      instruction: launch.instruction,
      inputFiles: [...launch.inputFiles],
      contextFiles: [...launch.contextFiles],
      mediaFiles: [...launch.mediaFiles],
    },
  };
}
