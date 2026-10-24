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
import { modelRefOf } from '@texra-ai/llm';
import { DocumentTaskOptionsSchema } from '@texra/shared/plugins/documents';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface, SurfaceAction } from '@texra/shared/session/surface';

type Launch = Surface['launch'];
/** An agent proposal as the view holds it. */
type AgentProposalPermission = Extract<
  SessionView['requests'][number]['payload'],
  { kind: 'proposal' }
>['data'];
type LaunchPatch = Extract<SurfaceAction, { kind: 'launch' }>['patch'];

/** The proposal's agent as an option value: options carry source-qualified
 *  keys, and a proposal with no source names the agent bare. */
function proposedAgentKey({ agent, agentSource }: AgentProposalPermission) {
  return agentSource == null ? agent : agentKey(agentSource, agent);
}

/** Whether an agent option value (a key) is the proposal's agent: the
 *  exact key, or, for a proposal with no source, any key of that name. */
function isProposedAgent(
  value: string,
  data: AgentProposalPermission,
): boolean {
  return (
    value === proposedAgentKey(data) ||
    (data.agentSource == null && agentName(value) === data.agent)
  );
}

/** The proposal the surface's form is open on, and the run asking. */
export function editedProposal(
  surface: Surface,
  view: SessionView,
): { readonly data: AgentProposalPermission; readonly run?: RunView } | null {
  const { editing } = surface;
  if (editing === null) return null;
  const request = view.requests.find(
    ({ runId, requestId }) =>
      runId === editing.runId && requestId === editing.requestId,
  );
  if (request?.payload.kind !== 'proposal') return null;
  return { data: request.payload.data, run: view.runs.get(editing.runId) };
}

/**
 * The agents a proposal may launch instead: the ones the asking run may
 * delegate to (its team's, which may be hidden from the catalog, else
 * every visible one), for a task only those with a document task, and the
 * proposed one always, so an unchanged form launches what was proposed.
 */
function proposalAgentOptions(
  data: AgentProposalPermission,
  run: RunView | undefined,
  host: HostSnapshot,
): HostSnapshot['agentOptions'] {
  const { task } = data;
  const offered = (option: HostSnapshot['agentOptions'][number]) =>
    !task || option.rounds !== undefined;
  const scope = run?.agentScope ?? null;
  const agents =
    scope === null
      ? host.agentOptions.filter(offered)
      : scope.flatMap((key) => {
          const option = host.agentOptions.find(({ value }) => value === key);
          // A member the catalog hides is offered as the team names it, but
          // for a task only when proposed: whether it has a task is not in
          // the catalog.
          if (option === undefined)
            return !task || isProposedAgent(key, data)
              ? [{ value: key, label: agentName(key) }]
              : [];
          return offered(option) ? [option] : [];
        });
  return agents.some((option) => isProposedAgent(option.value, data))
    ? agents
    : [{ value: proposedAgentKey(data), label: data.agent }, ...agents];
}

/** The catalogs as the launch form offers them: while it is open on a
 *  proposal, its agents are the proposal's and it offers no team. */
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
    teamOptions: [],
  };
}

/** The proposal's model as a model option names it: options carry a model
 *  without its effort or mode, which the proposal may (`ref@high`). */
function proposedModel(model: string, host: HostSnapshot): string {
  const ref = modelRefOf(model) ?? model;
  return host.modelOptions.some((option) => option.value === ref) ? ref : model;
}

/** The launch form filled with what the proposal would launch. */
export function proposalLaunchPatch(
  data: AgentProposalPermission,
  run: RunView | undefined,
  host: HostSnapshot,
): LaunchPatch {
  const agent =
    proposalAgentOptions(data, run, host).find((option) =>
      isProposedAgent(option.value, data),
    )?.value ?? data.agent;
  // Options the documents plugin cannot read open as its defaults.
  const options =
    DocumentTaskOptionsSchema.safeParse(data.options ?? {}).data ??
    DocumentTaskOptionsSchema.parse({});
  return {
    ...options,
    agent,
    model: proposedModel(data.model, host),
    instruction: data.instruction,
    inputFiles: [...data.inputFiles],
    contextFiles: [...data.contextFiles],
    mediaFiles: [...data.mediaFiles],
  };
}

/** The approval the form's Send answers: the proposal with the form's
 *  agent and model when they differ from it, and its instruction, files
 *  and, for a task, options, which the run compares with the proposal. */
export function proposalApproval(
  data: AgentProposalPermission,
  launch: Launch,
): Extract<RequestDecision, { action: 'approve' }> {
  const sameModel =
    launch.model === data.model || launch.model === modelRefOf(data.model);
  return {
    action: 'approve',
    agent: isProposedAgent(launch.agent, data) ? null : launch.agent,
    model: sameModel ? null : launch.model,
    instruction: launch.instruction,
    inputFiles: [...launch.inputFiles],
    contextFiles: [...launch.contextFiles],
    mediaFiles: [...launch.mediaFiles],
    options: data.task ? DocumentTaskOptionsSchema.parse(launch) : null,
  };
}
