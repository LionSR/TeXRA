/**
 * A proposal card's Edit: the launch form opened on an agent's proposal.
 * What the form offers while it is (the agents the asking run may delegate
 * to), what it opens with (the proposal as it would launch), and what its
 * Send answers (an approval carrying the form's changes).
 */
import {
  agentKey,
  agentName,
  type RequestDecision,
  type RunView,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { isAgentOption } from '@texra/shared/pickerOptions';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface, SurfaceAction } from '@texra/shared/session/surface';

type Launch = Surface['launch'];
/** An agent proposal as the view holds it. */
type AgentProposalRequest = Extract<
  SessionView['requests'][number]['payload'],
  { kind: 'proposal' }
>['data'];
type LaunchPatch = Extract<SurfaceAction, { kind: 'launch' }>['patch'];

/** The proposal's agent as an option value: options carry source-qualified
 *  keys, and a proposal with no source names the agent bare. */
function proposedAgentKey({ agent, agentSource }: AgentProposalRequest) {
  return agentSource == null ? agent : agentKey(agentSource.kind, agent);
}

/** Whether an agent option value (a key) is the proposal's agent. */
function isProposedAgent(value: string, data: AgentProposalRequest): boolean {
  return isAgentOption(value, proposedAgentKey(data));
}

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

/**
 * The agents a proposal may launch instead: for a chat, the ones the asking
 * run may delegate to (those its launch pinned, which may be hidden from the
 * catalog, else every visible one); for a program, none, since the proposal names
 * the program and not an agent. The proposed one is always among them, so
 * an unchanged form launches what was proposed.
 */
function proposalAgentOptions(
  data: AgentProposalRequest,
  run: RunView | undefined,
  host: HostSnapshot,
): HostSnapshot['agentOptions'] {
  const proposed = { value: proposedAgentKey(data), label: data.agent };
  if (data.task) return [proposed];
  const scope = run?.agentScope ?? null;
  const agents =
    scope === null
      ? host.agentOptions
      : scope.flatMap((key) => {
          const option = host.agentOptions.find(({ value }) => value === key);
          // A pinned agent the catalog hides is offered, by its key, only
          // when proposed.
          if (option === undefined)
            return isProposedAgent(key, data)
              ? [{ value: key, label: agentName(key) }]
              : [];
          return [option];
        });
  return agents.some((option) => isProposedAgent(option.value, data))
    ? agents
    : [proposed, ...agents];
}

/** The catalogs as the launch form offers them: while it is open on a
 *  proposal, its agents are the proposal's. */
export function formHost(
  surface: Surface,
  view: SessionView,
  host: HostSnapshot,
): HostSnapshot {
  const edited = editedProposal(surface, view);
  if (edited === null) return host;
  return {
    ...host,
    agentOptions: proposalAgentOptions(edited.data, edited.run, host),
  };
}

/** The launch form filled with what the proposal would launch. */
export function proposalLaunchPatch(
  data: AgentProposalRequest,
  run: RunView | undefined,
  host: HostSnapshot,
): LaunchPatch {
  const agent =
    proposalAgentOptions(data, run, host).find((option) =>
      isProposedAgent(option.value, data),
    )?.value ?? data.agent;
  return {
    agent,
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
 *  agent and model when they differ from it, and its instruction and
 *  files, which the run compares with the proposal. */
export function proposalApproval(
  data: AgentProposalRequest,
  launch: Launch,
): Extract<RequestDecision, { action: 'approve' }> {
  return {
    action: 'approve',
    ...(!isProposedAgent(launch.agent, data) && { agent: launch.agent }),
    ...(launch.model !== data.model && { model: launch.model }),
    instruction: launch.instruction,
    inputFiles: [...launch.inputFiles],
    contextFiles: [...launch.contextFiles],
    mediaFiles: [...launch.mediaFiles],
  };
}
