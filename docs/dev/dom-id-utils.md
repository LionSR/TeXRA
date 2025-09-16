# DOM ID utilities

TeXRA's webviews rely on consistent DOM ids for file selectors, multi-file lists, and their controls. The
`@common/domIdUtils.js` module centralizes these naming patterns so that UI code does not recreate template
literals in multiple places.

## Helper functions

All helpers accept a flexible `type` parameter. You can pass a base type such as `"input"`, a capitalized variant
like `"Input"`, or an existing identifier (`"inputFiles"`, `"InputFilesButton"`, etc.). The helpers normalize the
input before building the final id and throw if the type cannot be parsed.

- `getSingleFileId(type)` → returns the select element id (e.g., `inputFile`).
- `getMultipleFilesId(type)` → returns the multi-select list id (`inputFiles`).
- `getMultipleFilesContainerId(type)` → returns the container id that wraps the list (`inputFilesContainer`).
- `getToggleId(type)` → returns the toggle chevron id (`toggleInputFiles`).
- `getEmptySingleButtonId(type)` → returns the id for the single-file "Empty" button (`emptyInputFileButton`).
- `getEmptyMultipleButtonId(type)` → returns the id for the multi-file "Empty" button (`emptyInputFilesButton`).
- `getSelectMultipleButtonId(type)` → returns the id for the multi-file "Add" button (`selectInputFilesButton`).
- `getAddOpenedButtonId(type)` → returns the id for the "Add opened" button (`addOpenedInputFilesButton`).
- `getCurrentFileButtonId(type)` → returns the id for the "Current" button (`currentInputFileButton`).

## Usage guidelines

- Always derive DOM ids for file selectors and related controls with these helpers instead of inline template
  literals.
- Reuse the helpers when deriving keys from existing ids (e.g., `getSingleFileId('inputFiles')` → `inputFile`).
- When you introduce a new control that follows the same naming scheme, add a helper rather than duplicating the
  string pattern.
