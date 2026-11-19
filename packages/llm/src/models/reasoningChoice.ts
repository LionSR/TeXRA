/**
 * The one reasoning policy: what a request asks a model for, given the
 * model's documented reasoning controls and what the caller selected.
 *
 * llm-zoo records what each model accepts (`ModelConfig.reasoning`); this
 * module decides what to send. Every route and every agent (native, Claude
 * Code, Codex) goes through it, so the default, the handling of a level a
 * model lacks, and the report of what was changed are the same everywhere.
 */
import { Result, Schema } from 'effect';
import {
  EFFORT_SCALE,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
  type ModelSelection,
  type ReasoningMode,
} from 'llm-zoo';

import type { PlanRoute } from '../errors.js';
import type { ModelRoute } from './modelRoute.js';

/** The effort used when neither the caller nor the user names one. */
export const DEFAULT_EFFORT = ReasoningEffort.MEDIUM;

/**
 * The ChatGPT plan route's effort ceiling, applied through the one reasoning
 * policy. It was set for ChatGPT's Codex backend, which ran every turn
 * synchronously on one connection so that a higher effort risked a client
 * timeout; the token-sharing route streams over the public API and keeps the
 * ceiling until higher efforts are measured there.
 */
const CODEX_ROUTE_EFFORTS: readonly ReasoningEffort[] = [
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
];

/** The efforts each plan's backend serves; `undefined` for every effort
 *  the model has. */
const PLAN_EFFORTS = Object.freeze({
  'chatgpt-subscription': CODEX_ROUTE_EFFORTS,
  'xai-subscription': undefined,
  'kimi-code-subscription': undefined,
  'glm-coding-plan-subscription': undefined,
} satisfies Record<PlanRoute, readonly ReasoningEffort[] | undefined>);

/**
 * The reasoning controls `config` has on `route`; without a route, the
 * model's own. The one owner of what a route's request can say: the wire
 * rows derive from it. Each provider serves one protocol
 * (`BACKEND_PROTOCOLS`): Gemini's Interactions request and Kimi's Responses
 * request have no switch that turns thinking off, DashScope's has none that
 * turns Qwen's thinking on, MiniMax's names `high` as its one effort, and the
 * Codex subscription serves {@link CODEX_ROUTE_EFFORTS} only.
 */
function routeControls(
  config: Pick<ModelConfig, 'provider' | 'reasoning'>,
  route: ModelRoute | undefined,
): ModelConfig['reasoning'] {
  const { reasoning } = config;
  if (route === undefined || reasoning === undefined) return reasoning;
  switch (config.provider) {
    case ModelProvider.DASHSCOPE:
      return undefined;
    case ModelProvider.GOOGLE:
    case ModelProvider.MOONSHOT:
      return { ...reasoning, off: undefined };
    case ModelProvider.MINIMAX:
      return { ...reasoning, efforts: [ReasoningEffort.HIGH] };
    default: {
      const served =
        'plan' in route && route.plan !== null
          ? PLAN_EFFORTS[route.plan]
          : undefined;
      return served === undefined
        ? reasoning
        : {
            ...reasoning,
            efforts: reasoning.efforts.filter((effort) =>
              served.includes(effort),
            ),
          };
    }
  }
}

/** What a request asks for, and how that differs from what was selected. */
export interface ReasoningChoice {
  /** Whether the model thinks on this request. */
  readonly thinking: boolean;
  /** The effort level to send; `null` sends none (the model has no effort control, or thinking is off without one). */
  readonly effort: ReasoningEffort | null;
  readonly mode: ReasoningMode | null;
  /** Why `effort` is not the level asked for (explicitly or by default), for the run's log. */
  readonly note?: string;
}

/** The part of a selection that says how to run the model. */
export type ReasoningRequest = Omit<ModelSelection, 'ref'>;

/** A selection the model cannot run as asked. */
export class ReasoningChoiceError extends Schema.TaggedError<ReasoningChoiceError>()(
  'ReasoningChoiceError',
  { message: Schema.String },
) {}

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
): Result.Result<
  { effort: ReasoningEffort; note?: string },
  ReasoningChoiceError
> {
  if (accepted.includes(wanted)) return Result.succeed({ effort: wanted });
  const effort = nearestEffort(accepted, wanted);
  if (effort === undefined) {
    return Result.fail(
      new ReasoningChoiceError({
        message: `${label} does not accept effort ${wanted} (accepts ${accepted.join(', ') || 'no effort level'}).`,
      }),
    );
  }
  return Result.succeed({
    effort,
    note: `${label} has no ${wanted} effort; using ${effort} (accepts ${accepted.join(', ')}).`,
  });
}

/** How {@link chooseReasoning} resolves a request the model cannot serve. */
export interface ChooseReasoningOptions {
  /** The user's saved level for this model, used when the selection names none. */
  readonly userEffort?: ReasoningEffort;
  /** The route the request is bound on, which may carry fewer controls than the model has. */
  readonly route?: ModelRoute;
  /** The caller's own ceiling on the levels it can serve (e.g. an installed Codex CLI's). */
  readonly routeEfforts?: readonly ReasoningEffort[];
}

/**
 * Decide thinking, effort and mode for one request, over the controls the
 * model has on `options.route`.
 *
 * - The effort is the selection's, else the user's saved level, else
 *   {@link DEFAULT_EFFORT}.
 * - `none` turns thinking off; it is refused on a model that cannot stop
 *   thinking, as is thinking on a model that never thinks, because on/off
 *   changes the kind of answer, not its amount.
 * - Any other level the model lacks becomes the nearest level it has (ties
 *   go up), reported in `note`.
 *
 * A request the model cannot run as asked is the failure, a value the
 * caller branches on.
 */
export function chooseReasoning(
  config: Pick<ModelConfig, 'label' | 'provider' | 'reasoning' | 'modes'>,
  request: ReasoningRequest = {},
  options: ChooseReasoningOptions = {},
): Result.Result<ReasoningChoice, ReasoningChoiceError> {
  const reasoning = routeControls(config, options.route);
  const label = config.label;

  if (
    request.mode !== undefined &&
    !(config.modes ?? []).includes(request.mode)
  ) {
    return Result.fail(
      new ReasoningChoiceError({
        message: `${label} has no ${request.mode} mode.`,
      }),
    );
  }
  const mode = request.mode ?? null;
  const explicit = request.effort;
  const wanted = explicit ?? options.userEffort ?? DEFAULT_EFFORT;

  if (reasoning === undefined) {
    if (explicit !== undefined && explicit !== ReasoningEffort.NONE) {
      return Result.fail(
        new ReasoningChoiceError({
          message: `${label} does not reason; it cannot take effort ${explicit}.`,
        }),
      );
    }
    return Result.succeed({ thinking: false, effort: null, mode });
  }

  if (wanted === ReasoningEffort.NONE) {
    if (reasoning.off === undefined) {
      if (explicit === undefined) {
        // Only the user's saved `none` asked for this; the model always
        // thinks, so the default applies instead.
        return Result.map(
          chooseReasoning(
            config,
            { ...request, effort: DEFAULT_EFFORT },
            { ...options, userEffort: undefined },
          ),
          (choice) => ({
            ...choice,
            note: `${label} cannot turn thinking off; using the default ${DEFAULT_EFFORT}.`,
          }),
        );
      }
      return Result.fail(
        new ReasoningChoiceError({
          message: `${label} cannot turn thinking off.`,
        }),
      );
    }
    return Result.succeed({ thinking: false, effort: null, mode });
  }

  const accepted = options.routeEfforts
    ? reasoning.efforts.filter((effort) =>
        options.routeEfforts?.includes(effort),
      )
    : reasoning.efforts;
  // A model with no levels of its own, on a route that adds none, thinks
  // without one; a route ceiling that leaves it none refuses the level
  // instead (`snapped`).
  if (
    reasoning.efforts.length === 0 &&
    config.reasoning?.efforts.length === 0
  ) {
    if (explicit === undefined && options.userEffort === undefined)
      return Result.succeed({ thinking: true, effort: null, mode });
    return Result.succeed({
      thinking: true,
      effort: null,
      mode,
      note: `${label} has no effort levels; ignoring ${wanted}.`,
    });
  }
  return Result.map(snapped(accepted, wanted, label), (effort) => ({
    thinking: true,
    mode,
    ...effort,
  }));
}

/**
 * What `route` carries of a model's reasoning, over its controls there
 * (without a route, the model's own):
 *
 * - `acceptedEfforts`: the effort values it may send, the levels it accepts
 *   while thinking plus `none` where `none` is how thinking is turned off;
 * - `wireEffort`: the effort it sends for a {@link chooseReasoning} choice,
 *   the chosen level, or `none` when thinking is off and `none` is how the
 *   route says so.
 */
export function reasoningOnRoute(
  config: Pick<ModelConfig, 'provider' | 'reasoning'>,
  route?: ModelRoute,
): {
  readonly acceptedEfforts: readonly ReasoningEffort[];
  readonly wireEffort: (choice: ReasoningChoice) => ReasoningEffort | null;
} {
  const reasoning = routeControls(config, route);
  const offSendsNone = reasoning?.off !== undefined;
  return {
    acceptedEfforts:
      reasoning === undefined
        ? []
        : [
            ...(offSendsNone ? [ReasoningEffort.NONE] : []),
            ...reasoning.efforts,
          ],
    wireEffort: (choice) =>
      choice.thinking || !offSendsNone
        ? choice.effort
        : (choice.effort ?? ReasoningEffort.NONE),
  };
}
