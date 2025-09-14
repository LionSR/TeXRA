# DOM ID Helpers

TeXRA uses structured helpers in `@common/domIdUtils` to generate DOM element identifiers. These utilities replace inline
template literals and keep ID conventions consistent across modules.

## Available helpers

- `getToggleId(type)` – returns the ID for a toggle element, e.g. `toggleInputFiles`.
- `getSingleFileId(type)` – builds IDs like `inputFile`.
- `getMultipleFilesId(type)` – builds IDs like `inputFiles`.
- `getCapitalizedMultipleFilesId(type)` – same as above but capitalized (`InputFiles`).
- `getMultipleFilesContainerId(type)` – returns IDs such as `inputFilesContainer`.
- `getSelectButtonId(id)` – creates button IDs like `selectInputFilesButton`.
- `getEmptyButtonId(id)` – creates IDs such as `emptyInputFileButton` or `emptyInputFilesButton`.
- `getCurrentFileButtonId(type)` – builds IDs like `currentInputFileButton`.
- `getAddOpenedFilesButtonId(type)` – builds IDs like `addOpenedInputFilesButton`.

Use these helpers instead of manual string interpolation when constructing DOM IDs in webview code.
