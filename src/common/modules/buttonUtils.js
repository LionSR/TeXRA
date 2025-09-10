/**
 * Apply button configuration objects to DOM elements.
 * Each configuration may specify an `id` or `selector` to locate the element.
 * When `condition` is falsy, the element is hidden.
 * When `dataset` is provided, its key/value pairs are applied to the element's dataset.
 * When `handler` is provided, it is attached as an event listener (default event: "click").
 * A `configure` callback can perform additional custom logic on the element.
 *
 * @param {Document|ParentNode} root - Root node for element resolution.
 * @param {Array} configs - Array of button configuration objects.
 * @returns {Map<string, Function>} Map of element keys to handlers for later cleanup.
 */
export function applyButtonConfigs(root, configs) {
  const handlersMap = new Map();
  if (!configs) return handlersMap;

  configs.forEach((config) => {
    const {
      id,
      selector,
      element: explicitElement,
      condition = true,
      dataset,
      handler,
      event = 'click',
      configure,
    } = config;

    let el = explicitElement;
    if (!el) {
      if (id && root.getElementById) {
        el = root.getElementById(id);
      }
      if (!el && selector && root.querySelector) {
        el = root.querySelector(selector);
      }
    }

    if (!el) {
      return;
    }

    if (!condition) {
      el.style.display = 'none';
      return;
    }

    if (dataset) {
      Object.entries(dataset).forEach(([key, value]) => {
        if (value !== undefined) {
          el.dataset[key] = value;
        }
      });
    }

    if (handler) {
      el.addEventListener(event, handler);
      if (id) {
        handlersMap.set(id, handler);
      } else if (selector) {
        handlersMap.set(selector, handler);
      }
    }

    if (configure) {
      configure(el);
    }
  });

  return handlersMap;
}
