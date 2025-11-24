// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { bannerManager } from './BannerManager.js';
import {
  getSelectedOptionElement,
  isSelectLikeElement,
} from '@common/domUtils.js';

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

  if (!isSelectLikeElement(selectElement)) {
    if (forceShow) {
      bannerManager.showBanner(ELEMENT_IDS.API_KEY_BANNER, bannerPayload);
    }
    return;
  }

  const selectedOption = getSelectedOptionElement(selectElement);
  const provider = bannerPayload.provider ?? selectedOption?.dataset?.provider;
  const requiresKey =
    bannerPayload.requiresKey === true ||
    selectedOption?.dataset?.requiresKey === 'true';

  if (forceShow || requiresKey) {
    bannerManager.showBanner(ELEMENT_IDS.API_KEY_BANNER, {
      ...bannerPayload,
      provider,
    });
    return;
  }

  bannerManager.hideBanner(ELEMENT_IDS.API_KEY_BANNER);
}
