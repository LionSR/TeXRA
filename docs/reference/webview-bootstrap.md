# Webview Bootstrap Helper

The `bootstrap` function centralizes common setup logic for webview scripts.
It initializes state objects, registers message handlers and wires up lifecycle
callbacks so each view follows the same pattern.

## Usage

```js
import { bootstrap } from '@common/webview/bootstrap.js';

bootstrap({
  state: [viewState],
  messageHandler: {
    setup() {
      // register message listeners
    },
    cleanup() {
      // remove listeners
    },
  },
  onDomContentLoaded() {
    // initialize UI after the DOM is ready
  },
  onBeforeUnload() {
    // dispose resources before the view is unloaded
  },
});
```

## Options

| Option               | Description                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`              | Array of objects with optional `initialize()` and `restore()` methods. `initialize` runs immediately; `restore` runs after `DOMContentLoaded`. |
| `messageHandler`     | Object containing `setup()` and `cleanup()` methods for wiring VS Code message listeners.                                                      |
| `onDomContentLoaded` | Callback executed once the DOM is ready and state has been restored.                                                                           |
| `onBeforeUnload`     | Callback executed before the webview unloads.                                                                                                  |

Using this helper keeps webview entry scripts minimal and consistent across
views.
