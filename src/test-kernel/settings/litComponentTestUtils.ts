import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach } from 'vitest';

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
  'HTMLTextAreaElement',
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

function installAttachInternalsFallback(window: JSDOM['window']): void {
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
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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

    installAttachInternalsFallback(dom.window);

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
