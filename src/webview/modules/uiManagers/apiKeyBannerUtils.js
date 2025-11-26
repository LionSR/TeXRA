// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { bannerManager } from './BannerManager.js';
import {
  getSelectedOptionElement,
  isSelectLikeElement,
} from '@common/domUtils.js';

let apiKeyBannerState = { forced: false, visible: false };

/**
 * Syncs the API key banner with the currently selected model option.
 *
 * If a banner payload is provided, it will be used to show the banner even
 * when the select element is not yet available. Provider information is
 * derived from the payload or falls back to the selected option so the banner
 * remains model-specific.
 */
export function updateModelApiKeyBanner(
  selectElement,
  bannerPayload = {},
  options = {},
) {
  const { forceShow = false } = options;
  const wasForced = apiKeyBannerState.forced === true;
  const persistForced = wasForced || forceShow;

  if (!isSelectLikeElement(selectElement)) {
    if (forceShow) {
      bannerManager.showBanner(ELEMENT_IDS.API_KEY_BANNER, bannerPayload);
      apiKeyBannerState = { forced: persistForced, visible: true };
    }
    return;
  }

  const selectedOption = getSelectedOptionElement(selectElement);
  const requiresKey =
    bannerPayload.requiresKey !== undefined
      ? bannerPayload.requiresKey === true
      : selectedOption?.dataset?.requiresKey === 'true';
  const provider =
    bannerPayload.provider ??
    (requiresKey ? selectedOption?.dataset?.provider : undefined);

  if (forceShow || requiresKey) {
    const payload = provider
      ? { ...bannerPayload, provider }
      : { ...bannerPayload };

    bannerManager.showBanner(ELEMENT_IDS.API_KEY_BANNER, payload);
    apiKeyBannerState = { forced: persistForced, visible: true };
    return;
  }

  if (persistForced) {
    return;
  }

  bannerManager.hideBanner(ELEMENT_IDS.API_KEY_BANNER);
  apiKeyBannerState = { forced: false, visible: false };
}

export function hideModelApiKeyBanner() {
  apiKeyBannerState = { forced: false, visible: false };
  bannerManager.hideBanner(ELEMENT_IDS.API_KEY_BANNER);
}
