// A child run's delivery names its family, and its envelope is
// `<family>-result`, or `<family>-error` for one that carries a failure
// (`formatDelivery`). The harness names only the families its own child runs
// deliver in; a plugin's family is any name of the same shape.

/** The families the harness's own child runs deliver in, referenced by
 *  their producers instead of string literals. */
export const DELIVERY_FAMILY = Object.freeze({
  subagent: 'subagent',
  background: 'background',
  script: 'script',
} as const);

/** The attributes a harness delivery's summary line is read from: their
 *  producers write them and `deliverySummary` reads them by these names. */
export const DELIVERY_ATTRIBUTE = Object.freeze({
  /** The label of the agent that ran. */
  agent: 'agent',
  /** The outcome a completed run ended with. */
  status: 'status',
  /** What a background command ran. */
  command: 'command',
  /** The model's short description of a background command. */
  description: 'description',
} as const);

/** A delivery's family: lowercase words joined by `-`. */
export const DELIVERY_FAMILY_PATTERN = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
