import { LitElement, type PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';

import type { BannerState } from '@shared/schemas';

/**
 * Base for stateful warning banners whose IPC `state` payload carries a
 * `visible` flag. It mirrors `state.visible` onto a reflected `visible`
 * attribute so the `:host(:not([visible]))` rule in `bannerStyles` can hide the
 * host via CSS. Keeping the mirror here means each banner declares only its own
 * `state` shape. The visibility plumbing lives in exactly one place instead of
 * being copy-pasted per banner.
 */
export abstract class StateVisibleBanner<
  S extends BannerState,
> extends LitElement {
  abstract state: S;

  /** Reflected to the host so bannerStyles can hide the banner via CSS. */
  @property({ type: Boolean, reflect: true }) visible = false;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      this.visible = this.state.visible;
    }
  }
}
