import { isOwnDetailsToggle } from './detailsToggle';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

/**
 * Open/closed state for a single `<wa-details>`, guarded against the bubbled
 * `wa-show`/`wa-hide` of a nested `<wa-details>` (see `isOwnDetailsToggle`).
 * Bind `handleShow`/`handleHide` to the element's `wa-show`/`wa-hide` and
 * drive its `?open=` from `.open`.
 */
export class DetailsOpenController implements ReactiveController {
  private _open = false;
  private readonly onShow: (() => void) | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    options: { onShow?: () => void } = {},
  ) {
    this.onShow = options.onShow;
    host.addController(this);
  }

  // No teardown needed; present so the class isn't a `ReactiveController`
  // weak type (every member of the interface is optional).
  hostDisconnected(): void {}

  get open(): boolean {
    return this._open;
  }

  set open(value: boolean) {
    if (this._open === value) return;
    this._open = value;
    this.host.requestUpdate();
  }

  readonly handleShow = (event: Event): void => {
    if (!isOwnDetailsToggle(event)) return;
    this.open = true;
    this.onShow?.();
  };

  readonly handleHide = (event: Event): void => {
    if (!isOwnDetailsToggle(event)) return;
    this.open = false;
  };
}
