import { Schema } from 'effect';

// Local imports
import { agentName } from './agent';

/**
 * What kind of thing a run is, declared once at the launch site and carried
 * on `run.start`. The struct itself travels: on `run.start`, on `RunView`,
 * on child rows, and hosts add display fields beside it, never
 * re-encodings of it.
 */
export const RunIdentitySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('agent'),
    /** The run config's agent identifier, possibly source-qualified
     * ("custom:name") — the same value `AgentConfig.agent` carries. */
    agent: Schema.NonEmptyString,
    /** External CLI driving this agent ("codex", "claude_code"); absent for native. */
    tool: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal('process'),
    tool: Schema.NonEmptyString,
  }),
  /** A `script` call sent to the background: one run that runs it. */
  Schema.Struct({
    kind: Schema.Literal('script'),
    title: Schema.NonEmptyString,
  }),
]);

export type RunIdentity = typeof RunIdentitySchema.Type;

/** Whether an identity denotes a native agent rather than an external CLI. */
export function isPlainAgentIdentity(
  identity: RunIdentity | null | undefined,
): boolean {
  return identity?.kind === 'agent' && identity.tool === undefined;
}

/** Whether the harness's own loop drives the run, so a resume can continue
 *  it: a native agent's or a background script's. A process or an external CLI
 *  drives its own run. */
export function isLoopDriven(identity: RunIdentity): boolean {
  return isPlainAgentIdentity(identity) || identity.kind === 'script';
}

/** The identity's display name — what a listing row or tab label leads with. */
export function runIdentityName(id: RunIdentity): string {
  switch (id.kind) {
    case 'agent':
      return id.agent;
    case 'process':
      return id.tool;
    case 'script':
      return id.title;
  }
}

/** What a task started, by the kind of its run: the noun a count of them
 *  takes, in the order a summary lists them. */
export const NESTED_NOUNS = Object.freeze({
  agent: 'agent',
  process: 'command',
  script: 'script',
} as const satisfies Record<RunIdentity['kind'], string>);

/** What a run is called on screen and in a rejection: the task the user
 *  started (or a run the view no longer holds), else what a task started,
 *  by the kind of its run. */
export const runNoun = (
  run:
    | { readonly parentId: string | null; readonly identity: RunIdentity }
    | undefined,
): string =>
  run == null || run.parentId === null ? 'task' : NESTED_NOUNS[run.identity.kind];

/** UI label for a run identity — strips a known source prefix from agent ids. */
export function runIdentityDisplayName(id: RunIdentity): string {
  return agentName(runIdentityName(id));
}
