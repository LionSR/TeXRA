/**
 * The one reasoning policy: what a request asks a model for, given the
 * model's documented reasoning controls and what the caller selected.
 *
 * llm-zoo records what each model accepts (`ModelConfig.reasoning`); this
 * module decides what to send. Every route and every agent (native, Claude
 * Code, Codex) goes through it, so the default, the handling of a level a
 * model lacks, and the report of what was changed are the same everywhere.
 */
import { Data } from 'effect';
import {
  EFFORT_SCALE,
  ReasoningEffort,
  type ModelConfig,
  type ModelSelection,
  type ReasoningMode,
} from 'llm-zoo';

/** The effort used when neither the caller nor the user names one. */
const DEFAULT_EFFORT = ReasoningEffort.MEDIUM;

/** What a request asks for, and how that differs from what was selected. */
export interface ReasoningChoice {
  /** Whether the model thinks on this request. */
  readonly thinking: boolean;
  /** The effort level to send; `null` sends none (the model has no effort control, or thinking is off without one). */
  readonly effort: ReasoningEffort | null;
  readonly mode: ReasoningMode | null;
  /** The level that was asked for (explicitly or by default), when it differs from `effort`. */
  readonly requested?: ReasoningEffort;
  /** Why `effort` differs from `requested`, for the run's log. */
  readonly note?: string;
}

/** The part of a selection that says how to run the model. */
export type ReasoningRequest = Omit<ModelSelection, 'ref'>;

/** A selection the model cannot run as asked. */
export class ReasoningChoiceError extends Data.TaggedError(
  'ReasoningChoiceError',
)<{ readonly message: string }> {}

const rank = (effort: ReasoningEffort) => EFFORT_SCALE.indexOf(effort);

/**
 * The accepted level nearest to `wanted`; a tie goes to the higher level, so
 * a missing `medium` between `low` and `high` becomes `high`.
 */
function nearestEffort(
  accepted: readonly ReasoningEffort[],
  wanted: ReasoningEffort,
): ReasoningEffort | undefined {
  let best: ReasoningEffort | undefined;
  for (const effort of accepted) {
    const distance = Math.abs(rank(effort) - rank(wanted));
    const bestDistance =
      best === undefined ? Infinity : Math.abs(rank(best) - rank(wanted));
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        best !== undefined &&
        rank(effort) > rank(best))
    ) {
      best = effort;
    }
  }
  return best;
}

function snapped(
  accepted: readonly ReasoningEffort[],
  wanted: ReasoningEffort,
  label: string,
  strict: boolean,
): { effort: ReasoningEffort; requested?: ReasoningEffort; note?: string } {
  if (accepted.includes(wanted)) return { effort: wanted };
  const effort = nearestEffort(accepted, wanted);
  if (effort === undefined || strict) {
    throw new ReasoningChoiceError({
      message: `${label} does not accept effort ${wanted} (accepts ${accepted.join(', ') || 'no effort level'}).`,
    });
  }
  return {
    effort,
    requested: wanted,
    note: `${label} has no ${wanted} effort; using ${effort} (accepts ${accepted.join(', ')}).`,
  };
}

export interface ChooseReasoningOptions {
  /** The user's saved level for this model, used when the selection names none. */
  readonly userEffort?: ReasoningEffort;
  /** A route's own ceiling on the levels it can serve (e.g. the Codex subscription backend). */
  readonly routeEfforts?: readonly ReasoningEffort[];
  /** Refuse instead of substituting a nearby level. */
  readonly strict?: boolean;
}

/**
 * Decide thinking, effort and mode for one request.
 *
 * - The effort is the selection's, else the user's saved level, else
 *   {@link DEFAULT_EFFORT}.
 * - `none` turns thinking off; it is refused on a model that cannot stop
 *   thinking, as is thinking on a model that never thinks, because on/off
 *   changes the kind of answer, not its amount.
 * - Any other level the model lacks becomes the nearest level it has (ties
 *   go up), reported in `note`; `strict` refuses instead.
 */
export function chooseReasoning(
  config: Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>,
  request: ReasoningRequest = {},
  options: ChooseReasoningOptions = {},
): ReasoningChoice {
  const { reasoning } = config;
  const strict = options.strict ?? false;
  const label = config.label;

  if (
    request.mode !== undefined &&
    !(config.modes ?? []).includes(request.mode)
  ) {
    throw new ReasoningChoiceError({
      message: `${label} has no ${request.mode} mode.`,
    });
  }
  const mode = request.mode ?? null;
  const explicit = request.effort;
  const wanted = explicit ?? options.userEffort ?? DEFAULT_EFFORT;

  if (reasoning === undefined) {
    if (explicit !== undefined && explicit !== ReasoningEffort.NONE) {
      throw new ReasoningChoiceError({
        message: `${label} does not reason; it cannot take effort ${explicit}.`,
      });
    }
    return { thinking: false, effort: null, mode };
  }

  const thinkingOff =
    wanted === ReasoningEffort.NONE || request.thinking === false;
  if (thinkingOff) {
    if (reasoning.off === undefined) {
      if (explicit === undefined && request.thinking === undefined) {
        // Only the user's saved `none` asked for this; the model always
        // thinks, so the default applies instead.
        return {
          ...chooseReasoning(
            config,
            { ...request, effort: DEFAULT_EFFORT },
            { ...options, userEffort: undefined },
          ),
          requested: ReasoningEffort.NONE,
          note: `${label} cannot turn thinking off; using the default ${DEFAULT_EFFORT}.`,
        };
      }
      throw new ReasoningChoiceError({
        message: `${label} cannot turn thinking off.`,
      });
    }
    if (wanted === ReasoningEffort.NONE || reasoning.off.length === 0) {
      return { thinking: false, effort: null, mode };
    }
    const offAccepted = options.routeEfforts
      ? reasoning.off.filter((effort) => options.routeEfforts?.includes(effort))
      : reasoning.off;
    return {
      thinking: false,
      mode,
      ...snapped(offAccepted, wanted, `${label} without thinking`, strict),
    };
  }

  const accepted = options.routeEfforts
    ? reasoning.efforts.filter((effort) =>
        options.routeEfforts?.includes(effort),
      )
    : reasoning.efforts;
  if (reasoning.efforts.length === 0) {
    if (explicit === undefined && options.userEffort === undefined)
      return { thinking: true, effort: null, mode };
    return {
      thinking: true,
      effort: null,
      mode,
      requested: wanted,
      note: `${label} has no effort levels; ignoring ${wanted}.`,
    };
  }
  return { thinking: true, mode, ...snapped(accepted, wanted, label, strict) };
}

/**
 * The level a run uses for this model when nothing names one: `none` when it
 * does not think by default, `undefined` when it thinks without levels.
 */
export function defaultReasoningLevel(
  config: Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>,
): ReasoningEffort | undefined {
  const choice = chooseReasoning(config);
  return choice.thinking ? (choice.effort ?? undefined) : ReasoningEffort.NONE;
}

/**
 * The effort values a route may send for a model: the levels it accepts
 * while thinking, plus `none` where `none` is how thinking is turned off.
 */
export function acceptedEfforts(
  config: Pick<ModelConfig, 'reasoning'>,
): ReasoningEffort[] {
  const { reasoning } = config;
  if (reasoning === undefined) return [];
  return [
    ...(reasoning.off === undefined ? [] : [ReasoningEffort.NONE]),
    ...reasoning.efforts,
  ];
}

/** The effort a route sends: the chosen level, or `none` when thinking is off and `none` is how the route says so. */
export function wireEffort(
  config: ModelConfig,
  reasoning: ReasoningChoice,
): ReasoningEffort | null {
  if (reasoning.thinking || config.reasoning?.off === undefined) {
    return reasoning.effort;
  }
  return reasoning.effort ?? ReasoningEffort.NONE;
}
