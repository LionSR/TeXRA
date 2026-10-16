export { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
export type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
export { InlinePersonaSchema } from '@shared/schemas';
export type { InlinePersona, Persona } from '@shared/schemas';
// The payloads `RuntimePresentationEventPayloads` (root) names, one per
// notice a session's runs ask a host to present.
export type {
  FileLocation,
  InstructionAction,
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  ShowAgentConfigBannerPayload,
} from '@shared/schemas';
export type { RunEndResult } from '@agent/runtime/RunEndResult';
export { DEFAULT_AGENT_MODEL } from '@shared/constants/defaultModels';
export {
  AgentSourceSchema,
  RunIdSchema,
  RUN_OUTCOME,
  RunOutcomeSchema,
} from '@shared/schemas';
export type {
  AgentConfigInput,
  AgentSource,
  RunId,
  RunOutcome,
} from '@shared/schemas';
// Who an agent is: its source, the key a catalog names it by, and whether
// it ships with an installed package; and the actions an instruction offers.
export {
  AGENT_SOURCE,
  agentKey,
  INSTRUCTION_ACTION,
  isPackagedAgentSource,
} from '@shared/schemas';
// A session's events as a renderer reads them: the listing each belongs to,
// the aggregates it names, and a run's display name.
export {
  listingTypeOf,
  qualifyAggregateId,
  referencedAggregates,
  runIdentityDisplayName,
} from '@shared/schemas';
export type { DisplaySessionEvent } from '@shared/schemas';
// The card a plugin's tool states for its own call (an external agent's
// patch, thread or turn), in the section kinds every renderer paints.
export { ToolCardSchema } from '@shared/schemas';
export type { ToolCard } from '@shared/schemas';
// The route a request's usage is billed through: a subscription plan, or
// the user's API key.
export type { UsageRoute } from '@shared/schemas';
// Why a model option can or cannot run, as a picker shows it.
export type { ModelAvailabilityKind } from '@shared/schemas';
// Reads of a `SessionView` (root) for a renderer: what needs a person, how
// busy the session is, and where each run stands.
export {
  acceptsFollowUp,
  attentionOf,
  descendantRuns,
  isLiveRun,
  isWorkingRun,
  requestAnswerability,
  rollupOf,
  sessionActivity,
} from '@shared/session/sessionView';
export type {
  RequestAnswerability,
  SessionTitleState,
} from '@shared/session/sessionView';
// Whether a run's lifecycle status is in flight: running, or waiting for its
// next input; a ready, completed, failed or stopped run is not.
export { isInFlightPhase } from '@shared/runs/runStatus';
// The goal plugin's row, as a renderer reads a run's goal from it.
export { goalStateOf, type GoalState } from '@shared/plugins/goal';
// An exported run (`assembleTrace`), as a static viewer parses it back.
export {
  readTraceFacts,
  TraceDocumentSchema,
  type TraceDocument,
} from '@transcript/traceDocumentSchema';
