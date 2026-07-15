// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import { ULTRA_ONLY_PROVIDERS, type TierModelConfig } from './models.ts';

const SUPABASE_URL = 'https://supabase.test';
const TIERS = ['free', 'Max', 'Ultra'] as const;
const EXPECTED_ULTRA_ONLY_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
] as const;
const PROVIDER_API_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  glm: 'GLM_API_KEY',
} as const;

type Tier = (typeof TIERS)[number];

interface TierConfigResponse extends TierModelConfig {
  spendingLimits: Record<Tier, number>;
}

Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
for (const envKey of Object.values(PROVIDER_API_KEYS)) {
  Deno.env.set(envKey, 'provider-key');
}

const upstreamRequests: Request[] = [];

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

function getTierFromAuthorization(request: Request): Tier {
  const token = request.headers
    .get('authorization')
    ?.replace(/^Bearer /, '')
    .replace(/-token$/, '');
  assert.ok(TIERS.includes(token as Tier), `unexpected test token: ${token}`);
  return token as Tier;
}

globalThis.fetch = (input, init): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  if (url.origin !== SUPABASE_URL) {
    upstreamRequests.push(request);
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  if (url.pathname === '/auth/v1/user') {
    const tier = getTierFromAuthorization(request);
    return Promise.resolve(
      jsonResponse({
        id: `user-${tier}`,
        aud: 'authenticated',
        role: 'authenticated',
        email: `${tier.toLowerCase()}@example.com`,
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );
  }

  if (url.pathname === '/rest/v1/profiles') {
    const tier = getTierFromAuthorization(request);
    return Promise.resolve(
      jsonResponse({
        tier,
        access_expires_at: null,
        banned_until: null,
      }),
    );
  }

  if (url.pathname === '/rest/v1/rpc/get_user_monthly_relay_spend') {
    return Promise.resolve(jsonResponse(0));
  }

  if (url.pathname === '/rest/v1/rpc/relay_request_gate') {
    return Promise.resolve(
      jsonResponse({ allowed: true, slotId: 'test-slot' }),
    );
  }

  if (url.pathname === '/rest/v1/rpc/relay_request_release') {
    return Promise.resolve(jsonResponse(null));
  }

  throw new Error(`Unexpected test request: ${request.method} ${request.url}`);
};

// index.ts starts its server only when it is the entry point, so tests can
// invoke the same Hono application without opening a listening socket.
const { app } = await import('./index.ts');

async function getTierConfig(): Promise<TierConfigResponse> {
  const response = await app.request('/relay/tier-config');
  assert.equal(response.status, 200);
  return await response.json();
}

Deno.test('gates relay providers by tier at the route boundary', async () => {
  const config = await getTierConfig();
  assert.deepEqual(ULTRA_ONLY_PROVIDERS, EXPECTED_ULTRA_ONLY_PROVIDERS);
  const ultraOnlyProviders = new Set<string>(ULTRA_ONLY_PROVIDERS);
  assert.deepEqual(
    config.providers.toSorted(),
    Object.keys(PROVIDER_API_KEYS).toSorted(),
  );
  const ordinaryProviders = config.providers.filter(
    (provider) => !ultraOnlyProviders.has(provider),
  );

  assert.ok(ordinaryProviders.length > 0);

  const cases = TIERS.flatMap((tier) =>
    config.providers.map((provider) => ({
      tier,
      provider,
      restricted: tier !== 'Ultra' && ultraOnlyProviders.has(provider),
    })),
  );

  for (const testCase of cases) {
    upstreamRequests.length = 0;
    const response = await app.request(`/relay/${testCase.provider}/v1/files`, {
      headers: { authorization: `Bearer ${testCase.tier}-token` },
    });

    if (testCase.restricted) {
      assert.equal(
        response.status,
        403,
        `${testCase.tier} unexpectedly reached ${testCase.provider}`,
      );
      const body = await response.json();
      assert.equal(body.error.providerRestricted, true);
      assert.equal(body.error.provider, testCase.provider);
      assert.equal(body.error.requiredTier, 'Ultra');
      assert.equal(upstreamRequests.length, 0);
      continue;
    }

    assert.equal(
      response.status,
      204,
      `${testCase.tier} did not pass through ${testCase.provider}`,
    );
    assert.equal(upstreamRequests.length, 1);
  }
});

Deno.test(
  'excludes Ultra-only provider models from lower-tier config',
  async () => {
    const config = await getTierConfig();

    for (const tier of ['free', 'Max'] as const) {
      const models = config.tiers[tier]?.models;
      assert.ok(Array.isArray(models));

      for (const provider of ULTRA_ONLY_PROVIDERS) {
        const providerModels = Object.values(MODEL_CONFIGS)
          .filter(
            (model) =>
              model.provider.toLowerCase() === provider &&
              !model.openRouterOnly &&
              !model.retired,
          )
          .map((model) => model.name);

        assert.ok(providerModels.length > 0, `${provider} has no test models`);
        assert.equal(
          providerModels.some((model) => models.includes(model)),
          false,
          `${tier} config contains a ${provider} model`,
        );
      }
    }
  },
);
