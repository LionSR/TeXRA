import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach } from 'vitest';

type TestElementInternals = {
  validity?: ValidityState;
  validationMessage?: string;
  willValidate?: boolean;
  form?: HTMLFormElement | null;
  setValidity?: (flags?: ValidityStateFlags) => void;
  setFormValue?: (value: unknown, state?: unknown) => void;
  checkValidity?: () => boolean;
  reportValidity?: () => boolean;
};

type TestDomWindow = JSDOM['window'] & {
  ElementInternals?: {
    prototype: TestElementInternals;
  };
};

/**
 * Minimal ResizeObserver stub: jsdom doesn't implement it, and Web Awesome
 * controls (e.g. wa-textarea, used by the rejection-feedback box) construct one
 * in their `updated()` lifecycle. No-op observe/disconnect is enough for unit
 * tests, which don't assert on resize behavior.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const domGlobalKeys = [
  'window',
  'document',
  'Document',
  'customElements',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSlotElement',
  'HTMLDialogElement',
  'CustomEvent',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'ShadowRoot',
  'DocumentFragment',
  'Node',
  'CSSStyleSheet',
  'AbortController',
  'AbortSignal',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'MutationObserver',
] as const;

const DEFAULT_VALIDITY = {
  badInput: false,
  customError: false,
  patternMismatch: false,
  rangeOverflow: false,
  rangeUnderflow: false,
  stepMismatch: false,
  tooLong: false,
  tooShort: false,
  typeMismatch: false,
  valid: true,
  valueMissing: false,
} satisfies ValidityState;

function installAnimationPolyfill(window: JSDOM['window']): void {
  // jsdom doesn't implement Element.getAnimations; wa-dialog's
  // animateWithClass calls it to detect when no CSS animation is running and
  // resolve immediately. Returning [] means "no animations" — animateWithClass
  // resolves on the next raf, which matches the visible behavior in tests.
  const proto = window.Element?.prototype as
    (Element & { getAnimations?: () => unknown[] }) | undefined;
  if (!proto) return;
  if (typeof proto.getAnimations !== 'function') {
    proto.getAnimations = () => [];
  }
  // jsdom also doesn't implement the Web Animations API (Element.animate).
  // wa-details' internal animate() helper (used to drive its open/close
  // transition) calls `el.animate(keyframes, options).finished` directly —
  // without this, toggling a <wa-details> open/closed throws. Resolve
  // immediately so the open/close state settles synchronously enough for
  // tests to observe without waiting on a real animation. The stub's shape
  // intentionally doesn't match the real `Animation` return type — only
  // `.finished` is ever read by the code under test.
  if (typeof proto.animate !== 'function') {
    proto.animate = (() => ({
      finished: Promise.resolve(),
    })) as unknown as Element['animate'];
  }
}

function installDialogPolyfill(window: JSDOM['window']): void {
  // jsdom (as of 24.x) does not implement HTMLDialogElement's showModal/close.
  // wa-dialog calls these in firstUpdated; without them, attaching wa-dialog
  // throws and tests can't render the component. Provide a minimal polyfill
  // that only flips the `open` attribute.
  const proto = window.HTMLDialogElement?.prototype as
    | (HTMLDialogElement & { showModal?: () => void; close?: () => void })
    | undefined;
  if (!proto) return;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.show !== 'function') {
    (proto as HTMLDialogElement & { show: () => void }).show = function show(
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    };
  }
}

function installAttachInternalsFallback(window: TestDomWindow): void {
  // jsdom's attachInternals() exists but returns an ElementInternals stub
  // without setValidity / setFormValue / etc. Web Awesome's
  // WebAwesomeFormAssociatedElement (used by wa-button etc.) calls
  // `this.internals.setValidity(...)` during willUpdate, which crashes the test.
  // Override attachInternals to return a fully-stubbed shape that satisfies
  // every method WA touches.
  const HTMLElementCtor = window.HTMLElement as typeof HTMLElement | undefined;
  if (!HTMLElementCtor) {
    return;
  }
  const proto = HTMLElementCtor.prototype as unknown as HTMLElement & {
    attachInternals?: () => ElementInternals;
  };
  proto.attachInternals = function attachInternals() {
    return {
      setValidity: () => {},
      setFormValue: () => {},
      checkValidity: () => true,
      reportValidity: () => true,
      form: null,
      labels: [],
      validity: { ...DEFAULT_VALIDITY },
      validationMessage: '',
      willValidate: false,
      states: new Set<string>(),
    } as unknown as ElementInternals;
  };
}

function defineGetterIfMissing(
  prototype: object,
  name: string,
  get: (this: object) => unknown,
): void {
  if (name in prototype) return;
  Object.defineProperty(prototype, name, { configurable: true, get });
}

function installElementInternalsPolyfill(window: TestDomWindow): void {
  installAttachInternalsFallback(window);
  const ElementInternalsCtor = window.ElementInternals;
  if (!ElementInternalsCtor) {
    return;
  }

  const validityByInternals = new WeakMap<object, ValidityState>();
  const prototype = ElementInternalsCtor.prototype;

  defineGetterIfMissing(prototype, 'validity', function () {
    return validityByInternals.get(this) ?? DEFAULT_VALIDITY;
  });
  defineGetterIfMissing(prototype, 'validationMessage', () => '');
  defineGetterIfMissing(prototype, 'willValidate', () => true);
  defineGetterIfMissing(prototype, 'form', () => null);

  if (!prototype.setValidity) {
    prototype.setValidity = function setValidity(
      this: object,
      flags?: ValidityStateFlags,
    ) {
      const invalid = Object.values(flags ?? {}).some(Boolean);
      validityByInternals.set(this, {
        ...DEFAULT_VALIDITY,
        ...(flags ?? {}),
        valid: !invalid,
      });
    };
  }

  if (!prototype.setFormValue) {
    prototype.setFormValue = () => {
      /* jsdom does not implement form-associated custom element state. */
    };
  }

  if (!prototype.checkValidity) {
    prototype.checkValidity = function checkValidity(this: object) {
      return (validityByInternals.get(this) ?? DEFAULT_VALIDITY).valid;
    };
  }

  if (!prototype.reportValidity) {
    prototype.reportValidity = prototype.checkValidity;
  }
}

/**
 * Install the browser globals Lit components need, import the component module,
 * and reset the document between tests. Suites that import the module under
 * test from inside a test body (which already runs after the globals are in
 * place) can omit `importComponents`.
 */
export function useLitComponentTestDom(
  importComponents?: () => Promise<unknown>,
): void {
  let dom: JSDOM;
  const previousGlobals = new Map<
    (typeof domGlobalKeys)[number],
    { hadValue: boolean; value: unknown }
  >();

  beforeAll(async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://texra.local',
    });

    const replacements = {
      window: dom.window,
      document: dom.window.document,
      Document: dom.window.Document,
      customElements: dom.window.customElements,
      // Web Awesome components (wa-popup, wa-option, wa-dialog) read these
      // constructors as bare globals via instanceof checks and getAnimations
      // calls inside microtasks. Bind the jsdom-backed implementations onto
      // globalThis so those references resolve even after a test's beforeEach
      // tears down the previous DOM tree.
      Element: dom.window.Element,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLSlotElement: dom.window.HTMLSlotElement,
      HTMLDialogElement: dom.window.HTMLDialogElement,
      CustomEvent: dom.window.CustomEvent,
      Event: dom.window.Event,
      KeyboardEvent: dom.window.KeyboardEvent,
      MouseEvent: dom.window.MouseEvent,
      ShadowRoot: dom.window.ShadowRoot,
      DocumentFragment: dom.window.DocumentFragment,
      Node: dom.window.Node,
      CSSStyleSheet: dom.window.CSSStyleSheet,
      // wa-dialog (and other Web Awesome components) rely on these browser
      // globals; use the jsdom-backed implementations so AbortSignal/Event
      // identity matches the EventTarget instances they're attached to.
      AbortController: dom.window.AbortController,
      AbortSignal: dom.window.AbortSignal,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      // jsdom doesn't ship requestAnimationFrame; emulate it with setTimeout.
      // wa-dialog's animateWithClass and other Web Awesome components use raf
      // for "next paint" callbacks — a 0ms timeout is functionally equivalent
      // for unit-test timing.
      requestAnimationFrame: ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 0) as unknown as number) as (
        cb: FrameRequestCallback,
      ) => number,
      cancelAnimationFrame: ((handle: number) =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)) as (
        handle: number,
      ) => void,
      // jsdom lacks ResizeObserver; Web Awesome's wa-textarea constructs one.
      ResizeObserver: ResizeObserverStub,
      // jsdom implements MutationObserver on its own `window`, but the plain
      // Node globalThis used in this Vitest environment doesn't have one;
      // Web Awesome's wa-details (used by the "Followup"/panel-collapsible
      // wrapper) constructs one in firstUpdated().
      MutationObserver: dom.window.MutationObserver,
    } satisfies Record<(typeof domGlobalKeys)[number], unknown>;

    for (const key of domGlobalKeys) {
      previousGlobals.set(key, {
        hadValue: Object.hasOwn(globalThis, key),
        value: globalThis[key as keyof typeof globalThis],
      });
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: replacements[key],
      });
    }

    installElementInternalsPolyfill(dom.window);
    installDialogPolyfill(dom.window);
    installAnimationPolyfill(dom.window);
    await importComponents?.();
  });

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterAll(() => {
    dom.window.close();
    for (const key of domGlobalKeys) {
      const previous = previousGlobals.get(key);
      if (previous?.hadValue) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: previous.value,
        });
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
}

/**
 * Creates `tag`, assigns `props` before it is connected (so the first render
 * already sees them), attaches it to the document body, and waits for that
 * render to finish.
 */
export async function mountComponent<
  T extends { updateComplete: Promise<unknown> },
>(tag: string, props: Partial<T> = {}): Promise<T> {
  const element = document.createElement(tag) as unknown as T;
  Object.assign(element, props);
  document.body.append(element as unknown as HTMLElement);
  await element.updateComplete;
  return element;
}

/**
 * Dispatches the keydown a component's keyboard-activation handlers listen for:
 * bubbling and composed so shadow-DOM delegates see it, cancelable so a handler
 * calling `preventDefault()` is observable.
 */
export function dispatchKey(target: EventTarget, key: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}
