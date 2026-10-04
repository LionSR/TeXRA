/**
 * The verdict on a failure a binding raised, read off the vendor's reply:
 * the status it resolves to, whether repeating it can succeed, which route
 * it is evidence about, and whether it overflowed the window, used up a
 * quota or lost a stored continuation. The caller reads these fields and
 * never the SDK error behind them.
 *
 * The reply is the SDK error the adapter kept as `cause`; a failure with no
 * SDK error (a terminal event's own error object) is judged on its message
 * and status alone.
 */
import { Effect, Stream } from 'effect';

import { ModelError, type PlanRoute } from '../errors.js';
import {
  envelopes,
  firstNumber,
  firstString,
  isFields,
  numberField,
  readReply,
  stringField,
  type Fields,
  type Reply,
} from './failureReply.js';
import type { Model } from '../turn.js';

/** The route a binding bills through, which a few quota replies need. */
export type BillingRoute = PlanRoute | 'api-key';

type Quota = NonNullable<ModelError['quota']>;

/** OpenAI's own code for an overflowed window: a versioned contract field, not prose. */
const CONTEXT_LENGTH_CODE = 'context_length_exceeded';

/** The wording of vendors whose SDKs give an overflow no finer code than a 400. */
const CONTEXT_WINDOW_PHRASES = [
  'exceeds context window', // Anthropic
  'exceeds the context window', // OpenAI Responses API
  'context length exceeded', // Google
  'maximum context length', // OpenAI
  'token limit exceeded', // Anthropic
  'too many tokens', // OpenAI
  'input too long', // Google
] as const;

const phrasesOverflow = (message: string): boolean =>
  CONTEXT_WINDOW_PHRASES.some((phrase) =>
    message.toLowerCase().includes(phrase),
  );

/** Whether the reply, or the package's own refusal, says the input overflowed the window. */
function overflowsWindow(error: ModelError, reply: Reply): boolean {
  const { source, body } = reply;
  if (
    (isFields(source) && source.code === CONTEXT_LENGTH_CODE) ||
    (isFields(body) && body.code === CONTEXT_LENGTH_CODE)
  )
    return true;
  if (source instanceof Error && phrasesOverflow(source.message)) return true;
  return (
    error.kind === 'invalid-request' &&
    (phrasesOverflow(error.message) ||
      /context.?(window|length)|too many tokens|maximum context/i.test(
        error.message,
      ))
  );
}

/** Seconds until a GLM reset stamped in China time (UTC+8, no daylight saving). */
function secondsUntilChinaTime(message: string): number | undefined {
  const match = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(
    message,
  );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const resetMs = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  return Number.isNaN(resetMs)
    ? undefined
    : Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
}

/** GLM Coding Plan quota codes (all 429); pay-as-you-go GLM never sends them. */
const GLM_PLAN_EXHAUSTED: ReadonlySet<string> = new Set([
  '1308', // usage limit for a window
  '1309', // plan expired
  '1310', // weekly or monthly limit
  '1316', // past 5 hours
  '1317', // past 7 days
  '1318', // past 5 hours, monthly spend limit
  '1319', // past 7 days, monthly spend limit
  '1320', // past 5 hours, monthly spend limit
  '1321', // past 7 days, monthly spend limit
]);

/** GLM Coding Plan transient limits (1302 rate, 1305 overload): retry after a pause. */
const GLM_PLAN_BUSY: ReadonlySet<string> = new Set(['1302', '1305']);

/**
 * SuperGrok and Kimi Code share their API-key hosts, so their limits are
 * read by phrase and only on their own route. A transient rate limit
 * ("too many requests") matches neither.
 */
const SHARED_HOST_PLAN_LIMITS = [
  [
    'xai-subscription',
    /usage limit|quota.{0,24}(exceeded|exhausted|reached)|exceeded your (usage|quota)|weekly (usage )?limit|monthly (usage )?limit/i,
  ],
  [
    'kimi-code-subscription',
    /usage limit for this billing cycle|quota will be refreshed in the next cycle/i,
  ],
] as const;

const withReset = (
  quota: Omit<Quota, 'resetsInMs'>,
  seconds: number | undefined,
): Quota =>
  seconds === undefined ? quota : { ...quota, resetsInMs: seconds * 1000 };

/** The Codex backend's own `usage_limit_reached` reply, unique to the ChatGPT plan. */
function chatgptPlanLimit(body: unknown): Quota | undefined {
  const candidate = envelopes(body).find(
    (fields) => stringField(fields, 'type') === 'usage_limit_reached',
  );
  if (candidate === undefined) return undefined;
  const planType = stringField(candidate, 'plan_type');
  return withReset(
    {
      plan: 'chatgpt-subscription',
      ...(planType === undefined ? {} : { planType }),
    },
    numberField(candidate, 'resets_in_seconds'),
  );
}

/** A shared-host plan's limit phrase, on that plan's own route. */
function sharedHostPlanLimit(
  reply: Reply,
  route: BillingRoute,
): Quota | undefined {
  const limit = SHARED_HOST_PLAN_LIMITS.find(([plan]) => plan === route);
  const message =
    firstString(reply.body, 'message') ??
    (isFields(reply.source) ? stringField(reply.source, 'message') : undefined);
  if (limit === undefined || message === undefined || !limit[1].test(message))
    return undefined;
  return withReset(
    { plan: limit[0] },
    firstNumber(reply.body, 'resets_in_seconds'),
  );
}

/** The GLM Coding Plan's quota codes, with the reset its body states. */
function glmPlanLimit(body: unknown): Quota | undefined {
  const candidate = envelopes(body).find((fields) =>
    GLM_PLAN_EXHAUSTED.has(stringField(fields, 'code') ?? ''),
  );
  if (candidate === undefined) return undefined;
  return withReset(
    { plan: 'glm-coding-plan-subscription' },
    numberField(candidate, 'resets_in_seconds') ??
      secondsUntilChinaTime(stringField(candidate, 'message') ?? ''),
  );
}

/** The account itself is out of credit: OpenAI's `insufficient_quota`, Anthropic's low balance. */
const creditDepleted = (body: unknown): boolean =>
  envelopes(body).some((candidate) => {
    const type = stringField(candidate, 'type');
    const message = stringField(candidate, 'message')?.toLowerCase() ?? '';
    return (
      stringField(candidate, 'code') === 'insufficient_quota' ||
      type === 'insufficient_quota' ||
      (type === 'invalid_request_error' &&
        message.includes('credit balance is too low')) ||
      message.includes('exceeded your current quota')
    );
  });

/** The quota a reply says ran out: a plan's first, then the account's credit. */
const exhaustedQuota = (reply: Reply, route: BillingRoute): Quota | undefined =>
  chatgptPlanLimit(reply.body) ??
  sharedHostPlanLimit(reply, route) ??
  glmPlanLimit(reply.body) ??
  (creditDepleted(reply.body) ? { plan: null } : undefined);

/** A limit the provider scoped to one model, not the whole credential. */
const modelScopedLimit = (body: unknown): boolean =>
  envelopes(body).some(
    (candidate) =>
      (
        stringField(candidate, 'scope') ??
        stringField(candidate, 'rate_limit_scope') ??
        stringField(candidate, 'rateLimitScope')
      )?.toLowerCase() === 'model',
  );

const NETWORK_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** The error and its causes, guarding a cyclic chain. */
function causeChain(error: unknown): Fields[] {
  const chain: Fields[] = [];
  let link = error;
  while (isFields(link) && !chain.includes(link)) {
    chain.push(link);
    link = link.cause;
  }
  return chain;
}

/** The class names along an object's prototype chain. */
function classNames(value: Fields): string[] {
  const names: string[] = [];
  let prototype: unknown = Object.getPrototypeOf(value);
  while (isFields(prototype) && prototype !== Object.prototype) {
    const { constructor } = prototype;
    if (typeof constructor === 'function' && constructor.name !== '')
      names.push(constructor.name);
    prototype = Object.getPrototypeOf(prototype);
  }
  return names;
}

/** A coded link that names a network failure, or an undici stream timeout. */
const networkCode = ({ code, message }: Fields): boolean =>
  (typeof code === 'string' && NETWORK_CODES.has(code)) ||
  (code === 'UND_ERR_INFO' &&
    typeof message === 'string' &&
    /\b(?:stream )?timeout\b/i.test(message));

/**
 * Whether a transport failure shows the network itself failed: evidence
 * about the shared route. A coded cause decides, because undici wraps
 * deterministic failures (`UND_ERR_INVALID_ARG`) in the same `fetch failed`
 * as network ones; the wrapper message and the SDK connection or timeout
 * class count only when no link carries a code.
 */
function networkFailed(error: ModelError): boolean {
  const chain = causeChain(error.cause);
  const coded = chain.filter((link) => typeof link.code === 'string');
  if (coded.length > 0) return coded.some(networkCode);
  return chain.some(
    (link) =>
      (typeof link.message === 'string' &&
        /^(?:fetch failed|failed to fetch)$/i.test(link.message.trim())) ||
      classNames(link).some((name) =>
        /(?:Connection|Timeout)Error$/.test(name),
      ),
  );
}

const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 409 || status === 429;

/**
 * Whether repeating the request can succeed. Never for the package's own
 * refusals, an overflow (even under a retryable status: a rate limit that
 * mentions tokens is not one to repeat blindly), a used-up quota, or a
 * rejected credential; nor for a reply the SDK surfaced with no status,
 * which says nothing to repeat for. A status-less transport failure can.
 */
function retryable(
  error: ModelError,
  reply: Reply,
  overflow: boolean,
  quota: Quota | undefined,
): boolean {
  const { status } = reply;
  if (
    error.kind === 'invalid-request' ||
    error.kind === 'unsupported' ||
    error.kind === 'authentication' ||
    overflow ||
    quota !== undefined
  )
    return false;
  if (status !== undefined)
    return status !== 401 && status !== 403 && isRetryableStatus(status);
  return !(error.kind === 'provider-rejection' && error.cause instanceof Error);
}

/** A chained request's stored response is missing or past retention. */
const continuationGone = ({ status, message }: Reply): boolean =>
  status === 404 ||
  ((status === 400 || status === undefined) &&
    /previous[_ ]?(response|interaction)/i.test(message) &&
    /not found|expired|no longer|does not exist/i.test(message));

/** The failure's kind, refined by what the reply proves. */
function kindOf(
  error: ModelError,
  reply: Reply,
  terminalOverflow: boolean,
  quota: Quota | undefined,
): ModelError['kind'] {
  if (terminalOverflow) return 'context-overflow';
  if (quota !== undefined) return 'quota-exhausted';
  if (continuationGone(reply)) return 'continuation-gone';
  return reply.status === 429 ? 'rate-limited' : error.kind;
}

/** What the failure is evidence about beyond this request, where the reply says. */
function scopeOf(
  error: ModelError,
  reply: Reply,
  quota: Quota | undefined,
): Pick<ModelError, 'scope'> {
  if (
    reply.status === 429 &&
    quota === undefined &&
    modelScopedLimit(reply.body)
  )
    return { scope: 'model' };
  return error.kind === 'transport' && networkFailed(error)
    ? { scope: 'route' }
    : {};
}

/** The message to show: an overflow's own, the GLM plan's pause, else the reply's. */
function messageOf(reply: Reply, terminalOverflow: boolean): string {
  if (terminalOverflow)
    return (
      (reply.source instanceof Error ? reply.source.message.trim() : '') ||
      'Conversation exceeds the model context window.'
    );
  const busyPlan = envelopes(reply.body).some((fields) =>
    GLM_PLAN_BUSY.has(stringField(fields, 'code') ?? ''),
  );
  return busyPlan
    ? 'GLM Coding Plan rate limit reached. Wait a moment and retry; the plan is still active.'
    : reply.message;
}

/** `error` with the verdict its reply supports, for a binding that bills through `route`. */
export function judgeFailure(
  error: ModelError,
  route: BillingRoute,
): ModelError {
  const reply = readReply(error);
  const overflow = overflowsWindow(error, reply);
  // A retryable status keeps its kind: only a status that cannot succeed
  // again makes an overflow terminal.
  const terminalOverflow =
    overflow &&
    (reply.status === undefined || !isRetryableStatus(reply.status));
  const quota = terminalOverflow ? undefined : exhaustedQuota(reply, route);
  return new ModelError({
    ...error,
    kind: kindOf(error, reply, terminalOverflow, quota),
    message: messageOf(reply, terminalOverflow),
    cause: error.cause,
    retryable: retryable(error, reply, overflow, quota),
    ...(reply.status === undefined ? {} : { status: reply.status }),
    ...(quota === undefined ? {} : { quota }),
    ...scopeOf(error, reply, quota),
  });
}

/** `model` with every failure judged against the vendor's reply. */
export function judgedModel(model: Model, billing: BillingRoute): Model {
  const judge = (error: ModelError) => judgeFailure(error, billing);
  const { uploadFile, background } = model;
  return {
    prepareTurn: (request) =>
      Effect.mapError(model.prepareTurn(request), judge),
    streamTurn: (turn) => Stream.mapError(model.streamTurn(turn), judge),
    ...(uploadFile && {
      uploadFile: (file) => Effect.mapError(uploadFile(file), judge),
    }),
    ...(background && {
      background: {
        submit: (turn) => Effect.mapError(background.submit(turn), judge),
        observe: (turn, operation, policy) =>
          Stream.mapError(background.observe(turn, operation, policy), judge),
        cancel: (operation) =>
          Effect.mapError(background.cancel(operation), judge),
      },
    }),
  };
}
