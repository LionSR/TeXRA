/**
 * The page that issues each key provider's API keys. A leaf module: the
 * settings surfaces link three of these pages from their region toggles,
 * and `providerPresentation.ts`, which picks a page by the toggle, imports
 * the settings catalog those surfaces are joined into.
 */
import type { ApiKeyProviderId, RegionalProviderId } from '@texra-ai/llm';

/** A value that differs between a provider's two platforms. */
export interface Regional {
  readonly china: string;
  readonly international: string;
}

/** Each key provider's key page; a regional provider names one per platform. */
export const KEY_PAGES: {
  readonly [P in ApiKeyProviderId]: P extends RegionalProviderId
    ? Regional
    : string;
} = Object.freeze({
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://platform.claude.com/settings/keys',
  google: 'https://aistudio.google.com/app/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  moonshot: Object.freeze({
    china: 'https://platform.moonshot.cn/console',
    international: 'https://platform.moonshot.ai/console',
  }),
  dashscope: Object.freeze({
    china: 'https://bailian.console.aliyun.com/',
    international: 'https://dashscope.aliyun.com/api-console/',
  }),
  minimax: Object.freeze({
    china: 'https://platform.minimaxi.com/',
    international: 'https://platform.minimax.io/',
  }),
  glm: Object.freeze({
    china: 'https://open.bigmodel.cn/',
    international: 'https://z.ai/',
  }),
  meta: 'https://dev.meta.ai/',
  kimiCode: 'https://www.kimi.com/code/console',
});
