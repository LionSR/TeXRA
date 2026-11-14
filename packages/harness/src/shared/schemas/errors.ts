import { getReasonPhrase } from 'http-status-codes';
import { Result, Schema, String as Str, Struct } from 'effect';
import {
  ModelErrorFieldsSchema,
  PLAN_ROUTES,
  providerDisplayName,
} from '@texra-ai/llm';

import { formatResetDuration } from '@utils/text/stringUtils';

import { type DeclinableUsageRoute, DeclinableUsageRouteSchema } from './usage';

/** A route that bills a signed-in subscription session (ChatGPT, Grok). */
export const SubscriptionSessionRouteSchema = DeclinableUsageRouteSchema.pick([
  'chatgpt-subscription',
  'xai-subscription',
]);

/** A signed-in subscription that could not bill a call: its route, and
 *  whether only a fresh sign-in can help (else it may recover). */
export const SubscriptionSessionFailureSchema = Schema.Struct({
  route: SubscriptionSessionRouteSchema,
  needsReauth: Schema.Boolean,
});

/**
 * A model call's failure as a run records it: the verdict, never its words.
 * `model` is llm's verdict on the vendor's reply (its kind, the vendor's own
 * message and status, and the quota a used-up plan or credit names), `route`
 * is model access finding no route to send on (a missing key, a subscription
 * session that could not bill), and `interrupted` is an attempt the process
 * stopped during, which may have been billed without an answer. `provider`
 * is the binding's. Each reader words it ({@link modelFailureMessage}, or an
 * app's own copy), so a wording change is not a format change.
 */
export const ModelFailureSchema = Schema.Union([
  ModelErrorFieldsSchema.mapFields(
    Struct.pick(['kind', 'message', 'status', 'requestId', 'quota']),
  ).mapFields(
    Struct.assign({
      source: Schema.Literal('model'),
      provider: Schema.optional(Schema.String),
      /** Tail of the text the model streamed before the attempt failed:
       *  the retry surface shows that the work so far is not lost. */
      partialText: Schema.optional(Schema.String),
    }),
  ),
  Schema.Struct({
    source: Schema.Literal('route'),
    provider: Schema.optional(Schema.String),
    message: Schema.String,
    /** The route's credential is not set anywhere the run reads. */
    missingApiKey: Schema.optional(Schema.Literal(true)),
    session: Schema.optional(SubscriptionSessionFailureSchema),
  }),
  Schema.Struct({
    source: Schema.Literal('interrupted'),
    provider: Schema.optional(Schema.String),
  }),
]);
/** {@link ModelFailureSchema}'s value. */
export type ModelFailure = typeof ModelFailureSchema.Type;

/** A used-up plan as llm's verdict names it. */
export type UsedUpPlan = {
  readonly plan: DeclinableUsageRoute;
  readonly planType?: string | undefined;
  readonly resetsInMs?: number | undefined;
};

/** The plan a failure says ran out, with its tier and reset; none for the
 *  account's own credit or any other failure. */
export function usedUpPlanOf(failure: ModelFailure): UsedUpPlan | undefined {
  if (failure.source !== 'model') return undefined;
  const { quota } = failure;
  if (quota === undefined || quota.plan === null) return undefined;
  return { ...quota, plan: quota.plan };
}

/** An HTTP status's reason phrase; undefined for an unknown code (`getReasonPhrase` throws). */
export function reasonPhrase(statusCode: number): string | undefined {
  return Result.getOrUndefined(Result.try(() => getReasonPhrase(statusCode)));
}

/**
 * The provider a plan bills, by its own name (`OpenAI` for a ChatGPT plan):
 * how the plain words below name a plan, so an embedder without copy of its
 * own reads what ran out. An app's switch and sign-in labels are its copy,
 * worded from the same facts where it shows them.
 */
export const planOwner = (plan: DeclinableUsageRoute): string =>
  providerDisplayName(PLAN_ROUTES[plan].provider);

/**
 * A used-up plan in plain words, under the names its reader knows the plan
 * and its fallback by: what ran out, when it resets, and what to do.
 */
export function usageLimitMessage(
  used: UsedUpPlan,
  names: { readonly plan: string; readonly fallback: string },
): string {
  const tier = used.planType ? ` (${Str.capitalize(used.planType)} plan)` : '';
  const reset =
    used.resetsInMs === undefined
      ? ''
      : ` Resets in ${formatResetDuration(used.resetsInMs)}.`;
  return `${names.plan} usage limit reached${tier}.${reset} Switch to ${names.fallback} to keep working, or wait until the limit resets.`;
}

/** What a person is told of an attempt the process stopped during. */
const INTERRUPTED_MESSAGE =
  'The process stopped while a model request was running, so it may have been billed without an answer. Retry again?';

/**
 * A model call's failure in plain words, the one wording of the verdict for
 * every reader without copy of its own: a used-up plan says what ran out
 * and what to do; an overflowed window says why a retry cannot help; a
 * subscription session says its remedy; anything else is the vendor's
 * message under its status.
 */
export function modelFailureMessage(failure: ModelFailure): string {
  if (failure.source === 'interrupted') return INTERRUPTED_MESSAGE;
  if (failure.source === 'route') {
    const { message, session } = failure;
    if (session === undefined) return message;
    const remedy = session.needsReauth
      ? 'Sign in again'
      : 'Try again in a moment';
    return `Your ${planOwner(session.route)} subscription is unavailable: ${message} ${remedy}, or turn the subscription off.`;
  }
  const plan = usedUpPlanOf(failure);
  if (plan !== undefined)
    return usageLimitMessage(plan, {
      plan: `${planOwner(plan.plan)} subscription`,
      fallback: 'your own API key',
    });
  if (failure.kind === 'context-overflow')
    return (
      `${failure.message} Retrying would resend the same oversized request. ` +
      'Start a new session, or reduce attached files and tool output.'
    );
  const { status } = failure;
  const statusText = status === undefined ? undefined : reasonPhrase(status);
  const message = failure.message || statusText || 'Provider request failed';
  return status
    ? `HTTP ${status}${statusText ? ` ${statusText}` : ''} – ${message}`
    : message;
}

/** A failure as a host reads it: its plain words, the model call's verdict
 *  when one failed, and the vendor's raw body, which stays in the process
 *  log. */
export interface ProviderError {
  readonly message: string;
  readonly failure?: ModelFailure;
  readonly rawErrorBody?: unknown;
}

/** Context about where/when the error occurred */
const ErrorContextSchema = Schema.Struct({
  operation: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type ErrorContext = typeof ErrorContextSchema.Type;

/**
 * An error log row's data: a model call's failure as its verdict, or any
 * other failure's own words (`message`, and the error's text where it says
 * more, `rawMessage`), with where it happened. `decodeLogPayload` reads it
 * with `onExcessProperty: 'error'`: an earlier build's row carrying its
 * worded fields must fail loudly rather than read as a failure without one.
 */
export const ErrorLogDataSchema = Schema.Struct({
  failure: Schema.optional(ModelFailureSchema),
  message: Schema.optional(Schema.String),
  rawMessage: Schema.optional(Schema.String),
  ...ErrorContextSchema.fields,
});
export type ErrorLogData = typeof ErrorLogDataSchema.Type;
