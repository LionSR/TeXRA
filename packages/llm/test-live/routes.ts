/**
 * The HTTP provider routes the live matrix runs, by the name their suite
 * file and their cassette directory share.
 *
 * Model ids here are the cheapest generally available model on each route at
 * the time of writing. A provider retiring one fails its own suite and
 * nothing else; update the id here.
 */

// Local imports - the package under test
import type { RouteFacts } from '../src/models/modelRoute.js';

export interface LiveRoute {
  /**
   * The protocol as `TurnProtocolSchema` names it, qualified by the vendor
   * where two routes share one codec; also the suite name.
   */
  readonly protocol: string;
  /** The environment variable holding this route's credential. */
  readonly apiKeyEnv: string;
  /** The catalog model (`provider/id[@effort]`), bound as a run binds it. */
  readonly model: string;
  readonly endpoint: string;
  /** Route preferences beyond the model's own key (a coding plan). */
  readonly route?: Partial<RouteFacts>;
  /**
   * Whether the codec accepts an authored `continuation`. Where it does, the
   * matrix chains a second turn on the anchor the first returned; where it
   * does not, it asserts the explicit refusal the contract promises.
   */
  readonly continuation: 'supported' | 'unsupported';
}

export const ROUTES = {
  anthropicMessages: {
    protocol: 'anthropic-messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    continuation: 'unsupported',
    model: 'anthropic/claude-haiku-5-5@none',
    endpoint: 'https://api.anthropic.com',
  },
  dashscopeResponses: {
    protocol: 'openai-responses (DashScope)',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    // DashScope stores responses by default and chains on their ids.
    continuation: 'supported',
    model: 'dashscope/qwen3-max',
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  deepseekResponses: {
    protocol: 'openai-responses (DeepSeek)',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // Stateless: DeepSeek ignores storage, so every turn resends the prefix.
    continuation: 'unsupported',
    model: 'deepseek/deepseek-flash@none',
    endpoint: 'https://api.deepseek.com',
  },
  // A Coding Plan key on the endpoint API keys use; Zhipu serves Responses
  // to both from open.bigmodel.cn/api/v1, and this suite is that claim.
  glmCodingPlanResponses: {
    protocol: 'openai-responses (GLM Coding Plan)',
    apiKeyEnv: 'GLM_CODING_PLAN_API_KEY',
    // Zhipu stores responses for seven days and chains on their ids.
    continuation: 'supported',
    model: 'glm/glm-5.3@low',
    endpoint: 'https://open.bigmodel.cn/api/v1',
    route: { plans: ['glm-coding-plan-subscription'] },
  },
  glmResponses: {
    protocol: 'openai-responses (GLM)',
    apiKeyEnv: 'GLM_API_KEY',
    // Zhipu stores responses for seven days and chains on their ids.
    continuation: 'supported',
    model: 'glm/glm-5.3@low',
    endpoint: 'https://open.bigmodel.cn/api/v1',
  },
  googleInteractions: {
    protocol: 'google-interactions',
    apiKeyEnv: 'GOOGLE_API_KEY',
    // A stored interaction leaves an anchor over the steps it already holds;
    // the next turn sends only what follows them.
    continuation: 'supported',
    model: 'google/gemini-flash-latest@low',
    endpoint: 'https://generativelanguage.googleapis.com',
  },
  // A Kimi Code membership key: its own endpoint and quota, Kimi's wire.
  kimiCodeResponses: {
    protocol: 'openai-responses (Kimi Code)',
    apiKeyEnv: 'KIMI_CODE_API_KEY',
    // Stateless: Kimi takes no `store`, and fixes its own sampling.
    continuation: 'unsupported',
    model: 'moonshot/kimi-for-coding@low',
    endpoint: 'https://api.kimi.com/coding/v1',
  },
  kimiResponses: {
    protocol: 'openai-responses (Kimi)',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    // Stateless: Kimi takes no `store`, and fixes its own sampling.
    continuation: 'unsupported',
    model: 'moonshot/kimi-k3@low',
    endpoint: 'https://api.moonshot.ai/v1',
  },
  minimaxResponses: {
    protocol: 'openai-responses (MiniMax)',
    apiKeyEnv: 'MINIMAX_API_KEY',
    // Stateless: MiniMax documents no storage; its temperature range is (0, 1].
    continuation: 'unsupported',
    model: 'minimax/MiniMax-M3',
    endpoint: 'https://api.minimax.io/v1',
  },
  openaiResponses: {
    protocol: 'openai-responses',
    apiKeyEnv: 'OPENAI_API_KEY',
    // Stored responses plus response chaining: the codec returns an anchor
    // the next turn sends in place of the prefix it covers.
    continuation: 'supported',
    model: 'openai/gpt-4.1-mini-2025-04-14',
    endpoint: 'https://api.openai.com/v1',
  },
  xaiResponses: {
    protocol: 'openai-responses (xAI)',
    apiKeyEnv: 'XAI_API_KEY',
    // xAI stores responses and chains on their ids; a chained request
    // carries no instructions, since xAI refuses them beside
    // `previous_response_id`.
    continuation: 'supported',
    model: 'xai/grok-4.3@low',
    endpoint: 'https://api.x.ai/v1',
  },
  // Z.AI, Zhipu's international host, serves the same Responses API as
  // BigModel; a BigModel key is accepted here too.
  zaiResponses: {
    protocol: 'openai-responses (GLM, Z.AI)',
    apiKeyEnv: 'ZAI_API_KEY',
    // Zhipu stores responses for seven days and chains on their ids.
    continuation: 'supported',
    model: 'glm/glm-5.3@low',
    endpoint: 'https://api.z.ai/api/v1',
  },
} as const satisfies Record<string, LiveRoute>;

/** A route's name: its suite file's stem and its cassette directory. */
export type RouteName = keyof typeof ROUTES;
