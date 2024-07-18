# Frontend Changelog

## [0.6.9]
- Extensive code refactoring for improved maintainability and performance
- Optimized event handling and state management in WebView
- Improved file selection and UI update logic
- Enhanced error handling and user feedback
- Streamlined WebView message handling
- Added GPT-4 Omni- model option to the model selection dropdown
- Updated package.json to version 0.6.9
- Reorganized HTML structure for better maintainability
- Improved theme handling and application in WebView

## [0.6.8]

- Renamed 'selectMultipleFiles' to 'selectMultipleInputFiles' for improved clarity
- Refactored checkbox event handling in script.js
- Improved file selection update logic with new helper functions
- Reduced code duplication in WebView message handling
- Enhanced code organization and readability in script.js
- Updated version to 0.6.8 in package.json

## [0.6.7]

- Refactored 'getCurrentEditedFile' command to 'requestEditedFile' in script.js
- Removed unused 'getCurrentEditedFile' case in viewProvider.ts
- Improved code formatting in terminal.ts

## [0.6.6]

- Improved Git repository handling in VS Code extension
- Added check for Git repository before fetching commits
- Updated UI to display message when workspace is not a Git repository
- Disabled Git-related buttons when not in a Git repository
- Enhanced error handling for Git operations

## [0.6.5]

- Fixed WebView implementation issues
- Updated HTML file to use external CSS and JS files
- Adjusted CSP settings for proper resource loading
- Improved file handling and WebView content generation

## [0.6.4] Broken!!

- Refactored WebView implementation for improved maintainability
- Split HTML, CSS, and JavaScript into separate files
- Updated viewProvider.ts to load content from separate files
- Improved code organization and readability

## [0.6.3]

- Adaptive theming support for light and dark VS Code themes
- Improved UI consistency across different color schemes
- Updated file selection area to match VS Code's native dropdown styles
- Refactored CSS to use VS Code theme variables for better integration

## [0.6.2]

- Enhanced error handling in CoAuthorViewProvider for 'requestEditedFile' command
- Improved user feedback for file selection errors
- Updated version to 0.6.2 in package.json

## [0.6.1]

- Renamed "revision" to "edited" throughout the extension for improved consistency
- Updated UI elements, messages, and file handling to reflect this change
- Improved clarity in user interactions and file selection
- Added "None" option for input file selection in UI
- Enhanced file path handling for better cross-platform compatibility

## [0.6.0]

- Added support for new write-cover and write-proposal tasks
- Updated package.json to include new tasks in VS Code extension
- Enhanced UI to accommodate new writing tasks
- Improved file handling for sample/reference files in the extension

## [0.5.9]

- Added the merge button/functionality

## [0.5.8]

- Updated to support backend changes related to latexdiff functionality
- Improved handling of scratchpad output in the UI
- Enhanced error handling and user feedback for latexdiff operations
- Minor UI improvements and code cleanup

## [0.5.7]

- Removed unused `autoMergePartialOutput` option
- Updated main README with clearer project overview and installation instructions
- Revised frontend README with more detailed usage instructions
- Minor UI improvements and code cleanup

## [0.5.6]

- Implemented customizable tasks feature in VS Code settings
- Updated README with instructions for task customization
- Refactor task selection in WebView to use customizable tasks
- Bump version to 0.5.6
- Update package.json with new categories and publisher name
- Various minor improvements and bug fixes

## [0.5.5]

- Added support for sample file selection in the UI
- Implemented backend functionality for handling sample files
- Updated task options to include "Adapt" for both TeX and ST
- Improved file handling and diff operations
- Enhanced UI with better descriptions and layout
- Fixed issues with multiple file selection
- Optimized state management for selected files
- Various minor UI improvements and bug fixes

## [0.5.4]

- Added a "Empty" button for cleaning up the specific instructions

## [0.5.3]

- Added "Current" button for quick selection of the currently open file as input
- Added "Current" button to select the latest revision of the current input file
- Implemented backend logic to support new file selection features
- Updated UI to include new buttons and handle their functionality
- Improved file path handling for better cross-platform compatibility

## [0.5.2]

- Added "Clean" button for latexdiff-vc functionality
- Updated packLatexDiffVC command to support cleaning option
- Improved UI for latexdiff-vc section

## [0.5.1]

- Added auto-extract TikZ figure option in VS Code extension
- Implemented automatic TikZ figure extraction from LaTeX files
- Updated UI to include new auto-extract-relction TikZ figure checkbox
- Improved figure handling and extraction process
- Enhanced error handling and logging for figure-related operations
- Add Include TikZ Reflection and Auto-merge Partial Output Flags in the UI

## [0.5.0]

- Added auto-extract TikZ figure option in VS Code extension
- Implemented automatic TikZ figure extraction from LaTeX files
- Updated UI to include new auto-extract TikZ figure checkbox
- Improved figure handling and extraction process
- Enhanced error handling and logging for figure-related operations

## [0.4.7]

- Significantly improved UI layout and design for better user experience
- Redesigned file selection interface with support for multiple file selection
- Added compact selections for task, model, and reflect options
- Enhanced styling of buttons, selectors, and input areas
- Reorganized housekeeping and LaTeXDiff sections for improved clarity
- Increased initial height of task input textarea
- Various minor UI improvements and optimizations

## [0.4.6]

- Added the ability to reorder file lists in the UI
- Implemented drag-and-drop functionality for input files, auxiliary files, and figures
- Integrated Sortable.js library for smooth reordering experience
- Ensured state preservation after reordering files
- Minor UI improvements and bug fixes

## [0.4.5]

- Enhanced support for multiple file selection in the UI
- Implemented file removal functionality for input files, auxiliary files, and figures
- Improved state management for selected files
- Added visual feedback for file selection and removal
- Prevented duplicate file entries when selecting multiple files
- Various UI improvements and bug fixes

## [0.4.4]

- Added tex count functionality for LaTeX documents
- Improved figure handling with auto-extraction
- Enhanced CoAuthor extension UI to include tex count option
- Updated CLI to support new tex count feature
- Various minor improvements and bug fixes

## [0.4.3]

- Added auto-extract figure option in VS Code extension
- Implemented automatic figure path extraction from LaTeX files
- Improved polish functionality with refined prompts and better figure handling
- Enhanced reflection process for polishing task
- Various minor improvements and bug fixes

## [0.4.2]

- Streamlined TeX and ST processing by removing long versions of commands
- Merged polish_tex and polish_tex_long functionality
- Enhanced logging with summary statistics
- Added figure extraction and word count utility scripts
- Updated prompts for more detailed improvement plans
- Refactored model utility functions for better reusability
- Improved reflection process with more detailed action plans
- Added summary logging for both initial processing and reflection steps

## [0.4.1]

- small fixes to the execute button for the single auxiliary file case.

## [0.4.0]

- added the handling of multiple figures in the backend and make it works also in the frontend.

## [0.3.12]

- more fixes for selecting multiple input files and/or figures

## [0.3.11]

- fixes for selecting multiple input files and/or figures

## [0.3.10]

- UI optimizations

## [0.3.9]

- polish pass the multiple selected input files and/or figures to the backend: only show relative path if softlinks is encountered.

## [0.3.8]

- now possible to pass the multiple selected input files and/or figures to the backend

## [0.3.7]

- Added the possibility to select multiple input files and or figures, and display selected files in the extension UI (Activity Bar tab).
- Set the default open dialog for file selection to the same path of the select input file if it is set.

## [0.3.6]

- Set figure file to "None" and reflect to "False" when a task starting with "Correct" is selected.

## [0.3.5]

- increase the number of git commit message to show up to 20.
- handled softlinks folders

## [0.3.4]

- Added draw-tex and draw-st tasks in the backend and the UI.

## [0.3.3]

- Further Fixes to the clean-single function.

## [0.3.2]

- Fixed the clean-single function.

## [0.3.1]

- Safe housekeeping terminal.

## [0.3.0]

- A functional latexdiff/latexdiff-vs UI that automatically open the generated diff file

## [0.2.9]

- Added the latexdiff-vc button

## [0.2.8]

UI improvements and refresh button fix.

- moved to using h3 for section headers and h4 for subsections.
- right-aligned the button for latexdiff and latexdiff-vc

## [0.2.7]

- added the latexdiff-vs button to diff with a version in the commit history

## [0.2.6]

- small UI bump

## [0.2.5]

- added the automatic call to update the select revision file for latexdiff only for those that match the input.

## [0.2.4]

- handled the case when the housekeeping terminal is not available.

## [0.2.3]

- added the latexdiff button

## [0.2.2]

Quality of life improvements:

- gave a name to the housekeeping terminal.
- ignored more files and directories when searching for files.
- tweaking the continuation mode for claude and GPTs on the backend side.

## [0.2.1]

- Supported the pdf figure inputs.

## [0.2.0]

- Supported png and jpeg figure inputs.

## [0.1.9]

- Added a CleanSingle Button to clean up the generated file for the selected input.
- UI changes

## [0.1.8]

- Fixed the file filter to exclude certain files and directories

## [0.1.7]

- Fixed the passing of the reflection parameter to the backend

## [0.1.6]

- Fixed the bug that the model parameter is not passed to the backend correctly

## [0.1.5]

- Added hacks to process the scratchpad in the generated tex files

## [0.1.4]

- Created the Clean-Output Button
- Simplifies the execute logic

## [0.1.0]

- Added basic functionalities
- Initial release