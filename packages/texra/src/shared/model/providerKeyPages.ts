/**
 * Each API-key provider's key page: plain data with no runtime imports, so
 * the settings rows the browser webviews render and the model presentation
 * (`providerKeyUrl`) read the same URLs. A regional provider names one page
 * per platform, since its keys are platform-specific.
 */
import type { ApiKeyProviderId, RegionalProviderId } from '@texra-ai/llm';

/** Each key provider's key page; a regional provider names one per platform. */
export const KEY_PAGES: {
  readonly [P in ApiKeyProviderId]: P extends RegionalProviderId
    ? { readonly china: string; readonly international: string }
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
