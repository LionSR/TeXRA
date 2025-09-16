# DOM ID Helpers

Frontend modules frequently derive DOM ids from file types (e.g., converting
`input` to `inputFile`, `inputFiles`, or `toggleInputFiles`). Ad-hoc template
strings tended to drift and made it easy to reference the wrong element. The
`@common/domIdUtils.js` helpers provide a single source of truth for these
patterns.

## Available helpers

| Helper                                 | Purpose                                                         | Notes                                                             |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `getSingleFileId(type)`                | Returns the single-file `<select>` id (e.g., `inputFile`).      | Undefined for types without a single selector (such as `output`). |
| `getMultipleFilesId(type)`             | Returns the multi-select list id (e.g., `inputFiles`).          | Handles camel-cased values like `InputFiles`.                     |
| `getToggleId(type)`                    | Returns the chevron toggle id for a multi-select list.          | Useful for `fileList` visibility updates.                         |
| `getFilesContainerId(type)`            | Returns the container wrapper id (e.g., `inputFilesContainer`). |                                                                   |
| `getEmptySingleFileButtonId(type)`     | Id for the "Empty" button next to a single selector.            | Undefined when the control does not exist.                        |
| `getEmptyMultipleFilesButtonId(type)`  | Id for the "Empty" button next to a multi-select list.          |                                                                   |
| `getSelectMultipleFilesButtonId(type)` | Id for the "Select" button that opens the multi-file picker.    |                                                                   |
| `getAddOpenedFilesButtonId(type)`      | Id for the "Add opened" button.                                 | Only returns a value for `input`, `reference`, and `auxiliary`.   |
| `getCurrentFileButtonId(type)`         | Id for the "Current" button tied to a single-file selector.     |                                                                   |

The helpers accept plain types (`'input'`), DOM ids (`'inputFiles'`), or camel
case variants (`'InputFiles'`). Internally they normalize the value before
building the id. When an id does not exist (for example, `getSingleFileId('output')`)
the helper returns `undefined` so callers can skip the corresponding logic.

## Usage guidelines

- Always import helpers from `@common/domIdUtils.js` instead of constructing ids
  manually:

  ```javascript
  import { getToggleId, getMultipleFilesId } from '@common/domIdUtils.js';

  const listId = getMultipleFilesId(fileType);
  const toggleId = getToggleId(fileType);
  if (listId && toggleId) {
    fileList.update(listId, toggleId, files);
  }
  ```

- Reuse the helpers even when the input is already an id (e.g., `'inputFiles'`).
  They normalize the string and ensure consistent casing.
- Check for `undefined` when working with optional controls. This prevents calls
  to `document.getElementById` with ids that are not rendered in the DOM.

Centralizing these conversions keeps the UI managers, message handlers, and
state management code aligned. Any future adjustments to id formats only need to
be made in `domIdUtils`, and all dependent modules will follow the new pattern.
