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
import { Clock, DateTime, Effect, Schema, Struct } from 'effect';
import { PLAN_ROUTES, type ModelConfig } from '@texra-ai/llm';
import type { PlanUsageWindow } from '@texra-ai/llm/node';

// Local imports
import {
  PlanQuotas,
  type PlanQuota,
} from '@agent/runtime/modelAccess/planQuotas';
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

/** A time in the process's own zone, with its UTC offset. */
const zoned = (millis: number): string =>
  DateTime.formatIsoOffset(
    DateTime.makeZonedUnsafe(millis, { timeZone: DateTime.zoneMakeLocal() }),
  );

/** A model's listed prices, USD per million tokens. */
const listedPrices = (config: ModelConfig) => {
  const { longContextPricing: long } = config;
  return {
    input: config.inputPrice,
    cachedInput: config.inputPrice * config.capabilities.cacheDiscountFactor,
    output: config.outputPrice,
    ...(long !== undefined && {
      aboveInputTokens: {
        tokens: long.aboveInputTokens,
        input: long.inputPrice,
        cachedInput: long.inputPrice * long.cacheDiscountFactor,
        output: long.outputPrice,
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
  ...(window.resetAt !== undefined && { resetsAt: zoned(window.resetAt) }),
  ...(window.windowMinutes !== undefined && {
    windowMinutes: window.windowMinutes,
  }),
});

/** A plan's quota as the tool states it. */
const quotaOf = (quota: PlanQuota) => {
  switch (quota.state) {
    case 'read':
      return {
        source: 'quota endpoint',
        asOf: zoned(quota.at),
        ...(quota.planName !== undefined && { planName: quota.planName }),
        windows: quota.windows.map(windowOf),
      };
    case 'failed':
      return {
        source: 'quota endpoint',
        asOf: zoned(quota.at),
        failed: quota.reason,
      };
    case 'observed':
      return {
        source: 'reply headers',
        asOf: zoned(quota.at),
        windows: quota.windows.map(windowOf),
      };
    case 'unobserved':
      return {
        source: 'reply headers',
        unknown:
          'No reply on this plan has stated its quota since the process started.',
      };
    case 'unread':
      return {
        source: 'none',
        unknown: 'Nothing this process reads states the quota of this plan.',
      };
  }
};

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
      return {
        plan,
        on,
        quota:
          asksEndpoint && !on
            ? {
                source: 'quota endpoint',
                unknown: 'Not asked while the plan is off.',
              }
            : quotaOf(yield* quotas.read(plan, call.env.roots)),
      };
    }),
    { concurrency: 'unbounded' },
  );
});

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
    const cap = Schema.decodeUnknownOption(
      Schema.Struct({ maxCostUsd: Schema.Finite }),
    )(intent?.type === 'tool.intent' ? intent.payload.input : undefined);
    if (!answered && cap._tag === 'Some')
      caps.push({
        runId: run.id,
        maxCostUsd: cap.value.maxCostUsd,
        spentUsd: run.treeUsage.cost,
      });
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
const text = (now: string, timeZone: string, parts: Parts): string => {
  const usd = (n: number) => `$${Number(n.toPrecision(4))}`;
  const lines = [`Now: ${now} (${timeZone})`];
  if (parts.models.ok) {
    lines.push(
      'Models that can run now (billing; listed USD per million tokens input/cached input/output):',
      ...parts.models.value.map(
        ({ id, billing, listedUsdPerMillionTokens: p }) =>
          `- ${id}: ${billing}; ${p.input}/${p.cachedInput}/${p.output}`,
      ),
    );
  } else lines.push(`Models: not known (${parts.models.error})`);
  if (parts.plans.ok) {
    lines.push('Plans:');
    for (const { plan, on, quota } of parts.plans.value) {
      const head = `- ${plan} (${on ? 'on' : 'off'}): `;
      if ('unknown' in quota) lines.push(`${head}${quota.unknown}`);
      else if ('failed' in quota)
        lines.push(
          `${head}its quota endpoint failed (${quota.failed}) at ${quota.asOf}`,
        );
      else
        lines.push(
          `${head}${quota.windows
            .map(
              (w) =>
                `${w.name} ${w.remainingPercent}% left${'resetsAt' in w ? `, resets ${w.resetsAt}` : ''}`,
            )
            .join('; ')}; from its ${quota.source} as of ${quota.asOf}`,
        );
    }
  } else lines.push(`Plans: not known (${parts.plans.error})`);
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

/** A part that may fail to read: its value, or why it is not known. */
type Known<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

const known = <A, E extends Error, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((value): Known<A> => ({ ok: true, value })),
    Effect.catch((error) =>
      Effect.succeed<Known<A>>({ ok: false, error: error.message }),
    ),
  );

interface Parts {
  readonly models: Known<Effect.Success<ReturnType<typeof modelsNow>>>;
  readonly plans: Known<Effect.Success<ReturnType<typeof plansNow>>>;
  readonly spend: Effect.Success<ReturnType<typeof spendNow>>;
}

const runResources = Effect.fn('resources.call')(function* (call: RunToolCall) {
  // The host's clock, read once: the answer is recorded with the call.
  const now = yield* Clock.currentTimeMillis;
  const parts: Parts = yield* Effect.all(
    {
      models: known(modelsNow(call)),
      plans: known(plansNow(call)),
      spend: spendNow(call),
    },
    { concurrency: 'unbounded' },
  );
  const value = {
    now: zoned(now),
    timeZone: DateTime.zoneToString(DateTime.zoneMakeLocal()),
    ...(parts.models.ok
      ? { models: parts.models.value }
      : { modelsUnknown: parts.models.error }),
    ...(parts.plans.ok
      ? { plans: parts.plans.value }
      : { plansUnknown: parts.plans.error }),
    spend: parts.spend,
  };
  return {
    status: 'executed' as const,
    output: text(value.now, value.timeZone, parts),
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
    '{ now: string; timeZone: string; models?: { id: string; billing: string; listedUsdPerMillionTokens: { input: number; cachedInput: number; output: number; aboveInputTokens?: { tokens: number; input: number; cachedInput: number; output: number } } }[]; modelsUnknown?: string; plans?: { plan: string; on: boolean; quota: { source: string; asOf?: string; planName?: string; windows?: { name: string; remainingPercent: number; resetsAt?: string; windowMinutes?: number }[]; failed?: string; unknown?: string } }[]; plansUnknown?: string; spend: { runUsd: number; treeUsd: number; caps: { runId: string; maxCostUsd: number; spentUsd: number }[] } }',
  description: `Read the resources you have now. Takes no arguments and changes nothing.

It answers:
- \`now\`: the current time, ISO 8601 with its UTC offset, and \`timeZone\`, the zone it is in.
- \`models\`: the models a run can use now, each with \`billing\` (the subscription plan its next request is paid by, or \`api-key:<provider>\`) and its listed prices in US dollars per million tokens (input, cached input, output; \`aboveInputTokens\` when a longer prompt is billed at other rates). A request paid by a plan costs nothing per token; the listed prices are what the provider's API key is billed.
- \`plans\`: each subscription plan, whether it carries requests now (\`on\`), and what is known of its quota: each window's share remaining and when it resets, with \`asOf\`, when that was learned and from which \`source\`. A plan's quota endpoint is asked at most every 30 seconds; a plan whose replies state its quota is known only as of its last reply, which may be long ago. \`failed\` names why a quota read gave nothing; \`unknown\` says why nothing is known.
- \`spend\`: what this run has spent in US dollars (\`runUsd\`), and with every run it started (\`treeUsd\`), and \`caps\`: each spend cap a waiting call holds this run or a run it belongs to to; that run and the runs it started are stopped once their spend reaches \`maxCostUsd\`.

A field that could not be read is replaced by one that says why (\`modelsUnknown\`, \`plansUnknown\`).`,
  schema: Schema.Struct({}),
  execute: () => inRunSession(runResources),
});
