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
  'Node',
  'CSSStyleSheet',
  'AbortController',
  'AbortSignal',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
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
    | (Element & { getAnimations?: () => unknown[] })
    | undefined;
  if (!proto) return;
  if (typeof proto.getAnimations !== 'function') {
    proto.getAnimations = () => [];
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

const ATTACH_INTERNALS_PATCHED = Symbol.for(
  'texra.test.attachInternalsPatched',
);

export function installAttachInternalsFallback(window: TestDomWindow): void {
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
    [ATTACH_INTERNALS_PATCHED]?: boolean;
  };
  if (proto[ATTACH_INTERNALS_PATCHED]) {
    return;
  }
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
  Object.defineProperty(proto, ATTACH_INTERNALS_PATCHED, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: true,
  });
}

function installElementInternalsPolyfill(window: TestDomWindow): void {
  installAttachInternalsFallback(window);
  const ElementInternalsCtor = window.ElementInternals;
  if (!ElementInternalsCtor) {
    return;
  }

  const validityByInternals = new WeakMap<object, ValidityState>();
  const prototype = ElementInternalsCtor.prototype;

  if (!('validity' in prototype)) {
    Object.defineProperty(prototype, 'validity', {
      configurable: true,
      get() {
        return validityByInternals.get(this) ?? DEFAULT_VALIDITY;
      },
    });
  }

  if (!('validationMessage' in prototype)) {
    Object.defineProperty(prototype, 'validationMessage', {
      configurable: true,
      get() {
        return '';
      },
    });
  }

  if (!('willValidate' in prototype)) {
    Object.defineProperty(prototype, 'willValidate', {
      configurable: true,
      get() {
        return true;
      },
    });
  }

  if (!('form' in prototype)) {
    Object.defineProperty(prototype, 'form', {
      configurable: true,
      get() {
        return null;
      },
    });
  }

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
 * and reset the document between tests.
 */
export function useLitComponentTestDom(
  importComponents: () => Promise<unknown>,
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
    await importComponents();
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
