import { LitElement, type PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';

/**
 * Base for banners whose visibility the host drives directly: it mirrors the
 * `visible` property onto a reflected attribute so the `:host(:not([visible]))`
 * rule in `bannerStyles` can hide the host via CSS. Banners whose IPC `state`
 * payload carries the flag extend {@link StateVisibleBanner} instead, which
 * sets this property from `state.visible`.
 */
export abstract class VisibleBanner extends LitElement {
  /** Reflected to the host so bannerStyles can hide the banner via CSS. */
  @property({ type: Boolean, reflect: true }) visible = false;
}

/**
 * Base for stateful warning banners whose IPC `state` payload carries a
 * `visible` flag. It mirrors `state.visible` onto the reflected `visible`
 * attribute inherited from {@link VisibleBanner}, so a banner declares only its
 * own `state` shape and the visibility plumbing lives in exactly one place
 * instead of being copy-pasted per banner.
 */
export abstract class StateVisibleBanner<
  S extends { visible: boolean },
> extends VisibleBanner {
  abstract state: S;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      this.visible = this.state.visible;
    }
  }
}
