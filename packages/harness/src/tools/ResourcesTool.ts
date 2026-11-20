/**
 * The `resources` tool: what the run's resources are now, as the process
 * knows them. The time, the models that can run now with how each is
 * billed and its listed prices, what is known of each subscription plan's
 * quota and when it was learned, and what the run has spent with any cap
 * a waiting call holds it to. It reads and changes nothing else; its
 * result is journaled with the call, so a script that replays reads the
 * same answer.
 */
// Third-party imports
import { Clock, Effect, Option, Result, Schema, Struct } from 'effect';
import { PLAN_ROUTES, requestRates, type ModelConfig } from '@texra-ai/llm';
import type { PlanUsageWindow } from '@texra-ai/llm/node';

// Local imports
import {
  PlanQuotas,
  type PlanQuota,
} from '@agent/runtime/modelAccess/planQuotas';
import { CHILD_FIELDS } from '@agent/runtime/delegation/inputFields';
import { inRunSession, type RunToolCall } from '@agent/runtime/RunCall';
import { readModelOptions } from '@model/computeModelOptions';
import { readModelSettings } from '@model/modelSettings';
import {
  MODEL_AVAILABILITY_STATUS,
  toJsonValue,
  type RunId,
} from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import type { SessionView } from '@shared/session/sessionView';
import { defineTool } from '@tools/core/definition';
import { formatLocalTime } from '@utils/text/stringUtils';

/** One request's rates, USD per million tokens. */
const pricesOf = ({
  inputPrice,
  outputPrice,
  cacheDiscountFactor,
}: ReturnType<typeof requestRates>) => ({
  input: inputPrice,
  cachedInput: inputPrice * cacheDiscountFactor,
  output: outputPrice,
});

/** A model's listed prices on the standard tier, USD per million tokens:
 *  its flat rates, and those a prompt above its long-context threshold
 *  bills at, when it has one. */
const listedPrices = (config: ModelConfig) => {
  const long = config.longContextPricing?.aboveInputTokens;
  return {
    ...pricesOf(requestRates(config, 0)),
    ...(long !== undefined && {
      aboveInputTokens: {
        tokens: long,
        ...pricesOf(requestRates(config, long + 1)),
      },
    }),
  };
};

/** The models that can run now, in picker order, each with the route its
 *  next request bills and its catalog prices. */
const modelsNow = Effect.fn('resources.models')(function* (call: RunToolCall) {
  const options = yield* readModelOptions(call.env.roots);
  return options.flatMap((option) =>
    option.availability === 'unknown-model' ||
    !MODEL_AVAILABILITY_STATUS[option.availability].available
      ? []
      : [
          {
            id: option.model,
            billing: option.usageRoute ?? `api-key:${option.source}`,
            listedUsdPerMillionTokens: listedPrices(option.published),
          },
        ],
  );
});

const windowOf = (window: PlanUsageWindow) => ({
  name: window.name,
  remainingPercent: window.percentRemaining,
  ...(window.resetAt !== undefined && {
    resetsAt: formatLocalTime(window.resetAt),
  }),
  ...(window.windowMinutes !== undefined && {
    windowMinutes: window.windowMinutes,
  }),
});

/** A plan's windows as one line. */
const windowsText = (windows: readonly ReturnType<typeof windowOf>[]) =>
  windows
    .map(
      (w) =>
        `${w.name} ${w.remainingPercent}% left${'resetsAt' in w ? `, resets ${w.resetsAt}` : ''}`,
    )
    .join('; ');

/** A plan's quota as the tool states it, and as its line says it; `off`: a
 *  plan whose endpoint is not asked while it is off. */
const quotaOf = (quota: PlanQuota | { readonly state: 'off' }) => {
  switch (quota.state) {
    case 'read': {
      const asOf = formatLocalTime(quota.at);
      const windows = quota.windows.map(windowOf);
      return {
        quota: {
          source: 'quota endpoint',
          asOf,
          ...(quota.planName !== undefined && { planName: quota.planName }),
          windows,
        },
        text: `${windowsText(windows)}; from its quota endpoint as of ${asOf}`,
      };
    }
    case 'failed': {
      const asOf = formatLocalTime(quota.at);
      return {
        quota: { source: 'quota endpoint', asOf, failed: quota.reason },
        text: `its quota endpoint failed (${quota.reason}) at ${asOf}`,
      };
    }
    case 'observed': {
      const asOf = formatLocalTime(quota.at);
      const windows = quota.windows.map(windowOf);
      return {
        quota: { source: 'reply headers', asOf, windows },
        text: `${windowsText(windows)}; from its reply headers as of ${asOf}`,
      };
    }
    case 'unobserved':
      return unknown(
        'reply headers',
        'No reply on this plan has stated its quota since the process started.',
      );
    case 'unread':
      return unknown(
        'none',
        'Nothing this process reads states the quota of this plan.',
      );
    case 'off':
      return unknown('quota endpoint', 'Not asked while the plan is off.');
  }
};

/** A quota nothing states, and why. */
const unknown = (source: string, why: string) => ({
  quota: { source, unknown: why },
  text: why,
});

/** Every plan: whether it carries requests now, and what is known of its
 *  quota. A plan's endpoint is asked only while the plan is on. */
const plansNow = Effect.fn('resources.plans')(function* (call: RunToolCall) {
  const { route } = yield* readModelSettings(call.env.roots);
  const quotas = yield* PlanQuotas;
  return yield* Effect.forEach(
    Struct.keys(PLAN_ROUTES),
    Effect.fnUntraced(function* (plan) {
      const on = route.plans.includes(plan);
      const asksEndpoint = PLAN_ROUTES[plan].credential === 'key';
      const { quota, text } = quotaOf(
        asksEndpoint && !on
          ? { state: 'off' }
          : yield* quotas.read(plan, call.env.roots),
      );
      return { plan: { plan, on, quota }, text };
    }),
    { concurrency: 'unbounded' },
  );
});

/** The spend cap a child launch's input holds its child to, as the launch
 *  reads it. */
const decodeCap = Schema.decodeUnknownOption(
  Schema.Struct(Struct.pick(CHILD_FIELDS, ['maxCostUsd'])),
);

/**
 * The spend caps `runId` runs under: each run on its way to the root that a
 * call launched with `maxCostUsd` and still waits for, with what that run
 * and the runs under it have spent. A call that has its result holds
 * nothing any more.
 */
const capsOver = Effect.fn('resources.caps')(function* (
  view: SessionView,
  runId: RunId,
) {
  const log = yield* SessionLog;
  const caps: { runId: string; maxCostUsd: number; spentUsd: number }[] = [];
  for (
    let run = view.runs.get(runId);
    run?.launch?.card != null;
    run = view.runs.get(run.launch.id)
  ) {
    const card = run.launch.card;
    const rows = yield* log.history(run.launch.id, undefined, [
      'tool.intent',
      'tool.result',
    ]);
    const intent = rows.find(
      (row) => row.type === 'tool.intent' && row.payload.logId === card,
    );
    const answered = rows.some(
      (row) => row.type === 'tool.result' && row.payload.logId === card,
    );
    const maxCostUsd = Option.getOrUndefined(
      decodeCap(intent?.type === 'tool.intent' ? intent.payload.input : {}),
    )?.maxCostUsd;
    if (!answered && maxCostUsd != null)
      caps.push({ runId: run.id, maxCostUsd, spentUsd: run.treeUsage.cost });
  }
  return caps;
});

/** What the call's run, and it with every run under it, have spent. */
const spendNow = Effect.fn('resources.spend')(function* (call: RunToolCall) {
  const view = yield* (yield* SessionViewAccess).read([]);
  const run = view.runs.get(call.run.runId);
  return {
    runUsd: run?.usage.cost ?? 0,
    treeUsd: run?.treeUsage.cost ?? 0,
    caps: yield* capsOver(view, call.run.runId),
  };
});

/** The answer as lines. */
const text = (now: string, parts: Parts): string => {
  const usd = (n: number) => `$${Number(n.toPrecision(4))}`;
  const lines = [`Now: ${now}`];
  if (Result.isSuccess(parts.models))
    lines.push(
      'Models that can run now (billing; listed USD per million tokens input/cached input/output):',
      ...parts.models.success.map(
        ({ id, billing, listedUsdPerMillionTokens: p }) =>
          `- ${id}: ${billing}; ${p.input}/${p.cachedInput}/${p.output}`,
      ),
    );
  else lines.push(`Models: not known (${parts.models.failure.message})`);
  if (Result.isSuccess(parts.plans))
    lines.push(
      'Plans:',
      ...parts.plans.success.map(
        ({ plan: { plan, on }, text }) =>
          `- ${plan} (${on ? 'on' : 'off'}): ${text}`,
      ),
    );
  else lines.push(`Plans: not known (${parts.plans.failure.message})`);
  const { spend } = parts;
  lines.push(
    `Spent: this run ${usd(spend.runUsd)}; with the runs it started ${usd(spend.treeUsd)}`,
    ...(spend.caps.length === 0
      ? ['Spend caps: none']
      : spend.caps.map(
          (cap) =>
            `Spend cap: run ${cap.runId} and the runs it started stop at ${usd(cap.maxCostUsd)}; spent ${usd(cap.spentUsd)}`,
        )),
  );
  return lines.join('\n');
};

/** What the call reads: the models and plans each read or why not. */
interface Parts {
  readonly models: Result.Result<
    Effect.Success<ReturnType<typeof modelsNow>>,
    Effect.Error<ReturnType<typeof modelsNow>>
  >;
  readonly plans: Result.Result<
    Effect.Success<ReturnType<typeof plansNow>>,
    Effect.Error<ReturnType<typeof plansNow>>
  >;
  readonly spend: Effect.Success<ReturnType<typeof spendNow>>;
}

const runResources = Effect.fn('resources.call')(function* (call: RunToolCall) {
  // The host's clock, read once: the answer is recorded with the call.
  const now = yield* Clock.currentTimeMillis;
  const parts: Parts = yield* Effect.all(
    {
      models: Effect.result(modelsNow(call)),
      plans: Effect.result(plansNow(call)),
      spend: spendNow(call),
    },
    { concurrency: 'unbounded' },
  );
  const value = {
    now: formatLocalTime(now),
    ...(Result.isSuccess(parts.models)
      ? { models: parts.models.success }
      : { modelsUnknown: parts.models.failure.message }),
    ...(Result.isSuccess(parts.plans)
      ? { plans: parts.plans.success.map(({ plan }) => plan) }
      : { plansUnknown: parts.plans.failure.message }),
    spend: parts.spend,
  };
  return {
    status: 'executed' as const,
    output: text(value.now, parts),
    summary: 'Read resources',
    value: toJsonValue(value),
  };
});

/** The `resources` tool. */
export const ResourcesTool = defineTool({
  name: 'resources',
  replay: 'safe',
  lane: 'parallel',
  scriptReturns:
    '{ now: string; models?: { id: string; billing: string; listedUsdPerMillionTokens: { input: number; cachedInput: number; output: number; aboveInputTokens?: { tokens: number; input: number; cachedInput: number; output: number } } }[]; modelsUnknown?: string; plans?: { plan: string; on: boolean; quota: { source: string; asOf?: string; planName?: string; windows?: { name: string; remainingPercent: number; resetsAt?: string; windowMinutes?: number }[]; failed?: string; unknown?: string } }[]; plansUnknown?: string; spend: { runUsd: number; treeUsd: number; caps: { runId: string; maxCostUsd: number; spentUsd: number }[] } }',
  description: `Read the resources you have now. Takes no arguments and changes nothing.

It answers:
- \`now\`: the current time in this machine's zone: ISO 8601 with its UTC offset, then the zone's name in brackets. Every time in the answer is written the same way.
- \`models\`: the models a run can use now, each with \`billing\` (the subscription plan its next request is paid by, or \`api-key:<provider>\`) and its listed prices in US dollars per million tokens (input, cached input, output; \`aboveInputTokens\` when a longer prompt is billed at other rates). A request paid by a plan costs nothing per token; the listed prices are what the provider's API key is billed.
- \`plans\`: each subscription plan, whether it carries requests now (\`on\`), and what is known of its quota: each window's share remaining and when it resets, with \`asOf\`, when that was learned and from which \`source\`. A plan's quota endpoint is asked at most every 30 seconds; a plan whose replies state its quota is known only as of its last reply, which may be long ago. \`failed\` names why a quota read gave nothing; \`unknown\` says why nothing is known.
- \`spend\`: what this run has spent in US dollars (\`runUsd\`), and with every run it started (\`treeUsd\`), and \`caps\`: each spend cap a waiting call holds this run or a run it belongs to to; that run and the runs it started are stopped once their spend reaches \`maxCostUsd\`.

A field that could not be read is replaced by one that says why (\`modelsUnknown\`, \`plansUnknown\`).`,
  schema: Schema.Struct({}),
  execute: () => inRunSession(runResources),
});
