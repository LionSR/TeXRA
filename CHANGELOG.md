# Backend Changelog

## [0.9.9]

- Updated backend to support new output file options from frontend
- Enhanced error handling for new output file functionality
- Improved modularity and organization of the codebase
- Various minor code improvements and optimizations
- Added output_name_override option to pack-single and clean-single CLI commands
- Updated pack_single and clean_single functions to use output name override
- Improved file naming logic to support custom output names
- Enhanced error handling for new output name override functionality


## [0.9.8]

- Added new GPT-4 Omni- model option with 16k token limit
- Updated model selection options in CLI and configuration
- Adjusted model handling logic to accommodate the new GPT-4 Omni- option
- Enhanced token limit management for the new model

## [0.9.7]

- Refactored pack_single and clean_single functions in cli.py for improved file handling and consistency
- Added get_file_patterns function to centralize file pattern generation
- Improved logging and debugging output in pack and clean operations

## [0.9.6]

- Added intelligent merge functionality for LaTeX documents
- Enhanced error handling in CoAuthorViewProvider for 'requestEditedFile' command
- Added new function get_output_file_name_merge in output_utils.py
- Improved pattern handling in clean_single and pack_single functions in cli.py
- Added process_tikzpicture_endings function in tex_tools.py for better TikZ handling
- Updated process_first_round and process_reflection_round functions in process.py to handle scratchpad output
- Updated merge.py to use get_output_file_name_merge function

## [0.9.5]

- Updated CLI commands to use --input_file and --edited_file options for improved clarity and consistency
- Changed default model in get_common_env function from "opus" to "sonnet+"
- Refactored CLI commands to use new input file options
- Improved error handling and input validation for file paths
- Various minor code improvements and optimizations

## [0.9.4]

- Renamed "revision" to "edited" throughout the codebase for improved consistency
- Updated function names, variables, and UI elements to reflect this change
- Improved clarity in file handling and user interactions

## [0.9.3]

- Added new write-cover and write-proposal tasks
- Implemented write_tex.py for handling new writing tasks
- Fixed bug in scratchpad output handling in output_utils.py
- Enhanced task handling with get_first_task_chunk function in cli.py
- Updated CLI to support new writing tasks
- Improved file handling for sample/reference files
- Refactored code for better modularity and consistency
- Added new user prefix templates for cover letter and proposal tasks
- Updated package.json to include new tasks in VS Code extension

## [0.9.2]

- Refactored `process_first_round` function to return fewer values
- Moved system prompt loading to `get_prompt_settings` for better organization
- Updated all task files to use the new `process_first_round` function signature
- Improved handling of scratchpad content in `split_scratchpad_output`
- Minor code improvements and optimizations

## [0.9.1]

- Added `log_end` function to properly close log files
- Implemented figure input support in reflection rounds
- Improved error handling and file processing across multiple tasks
- Enhanced modularity and organization of the codebase
- Updated all task files to use new logging utilities and figure input handling (a bug fix!)
- Improved consistency in logging and error handling
- Various minor code improvements and optimizations

## [0.9.0]

- Refactored latexdiff functionality for improved performance and reliability
- Introduced new `split_scratchpad_output` function to handle scratchpad content separately
- Updated latexdiff and latexdiff-vc commands with improved options, including UTF-8 encoding support
- Implemented scratchpad splitting in various task files (adapt.py, edit_lecture.py, edit_tex.py, lecture2text.py, merge.py)
- Fixed an issue with "\end{document}" tag handling in scratchpad output
- Improved error handling and logging in latexdiff-related functions
- Various minor code improvements and optimizations
- Optimized the process function
- Added the merge button/functionality

## [0.8.9]

- Refactored latexdiff functionality for improved performance and reliability
- Introduced new `split_scratchpad_output` function to handle scratchpad content separately
- Updated latexdiff and latexdiff-vc commands with improved options, including UTF-8 encoding support
- Implemented scratchpad splitting in various task files (adapt.py, edit_lecture.py, edit_tex.py, lecture2text.py, merge.py)
- Fixed an issue with "\end{document}" tag handling in scratchpad output
- Improved error handling and logging in latexdiff-related functions
- Various minor code improvements and optimizations

## [0.8.8]

- Refactored TikZ figure extraction process for improved file handling and compatibility
- Updated user prefix templates for better consistency and XML formatting
- Enhanced latexdiff functionality to include task-specific differentiation (a fix)
- Simplified imports in various task files using 'import coauthor as coa'
- Improved file path handling in figure extraction and compilation
- Fixed XML formatting issues in user prefix templates
- Various minor code improvements and bug fixes

## [0.8.7]

- Refactored CLI and argument handling for improved modularity
- Removed unused `autoMergePartialOutput` option
- Adjusted log output formatting
- Minor code cleanup and improvements

## [0.8.6]

- Added 'write-tex' command to CLI
- Fixed typos in system prompts
- Updated version to 0.8.6 in pyproject.toml
- Minor code improvements and refactoring

## [0.8.5]

- Refactored codebase for improved modularity and efficiency
- Simplified imports using 'import coauthor as coa' across all task files
- Removed redundant code and consolidated shared functionality
- Updated all task files to use new module structure
- Improved error handling and logging
- Enhanced code readability and maintainability
- Updated reflection prompts to emphasize critical review
- Various minor improvements and bug fixes

## [0.8.4]

- Implemented figure inputs support in the reflection round
- Refactored TikZ extraction process for improved compatibility and file handling
- Updated CLI to support new figure-related options, including --include_tikz_reflection
- Improved error handling and file processing in various utilities
- Enhanced modularity and organization of the codebase
- Updated figure handling in process.py and figure_tools.py
- Refactored settings handling to separate figure inputs

## [0.8.3]

- Modified pack_latexdiff_vc function to handle both packing and cleaning
- Added --clean flag to pack_latexdiff_vc CLI command
- Improved error handling and file processing in pack_latexdiff_vc

## [0.8.2]

- Simplified CLI command implementations using shared arguments and kwargs
- Updated log_utils.py to format instruction logging
- Enhanced image message creation for different model types
- Updated user prefix for merge task

## [0.8.1]

- Added auto-merge partial output functionality
- Improved error handling and logging for auto-merge operations
- Refactored auto-merge code for better modularity

## [0.8.0]

- Added auto-extract TikZ figure functionality
- Improved figure path extraction, including support for `\graphicspath`
- Enhanced logging for figure-related operations
- Refactored figure handling code for better modularity
- Updated CLI to support new TikZ figure extraction option
- Improved error handling and debugging output for figure operations

## [0.7.11]

- Enhanced `extract_figure_paths` function to also look under `\graphicspath` for figures.
- Added regular expression to match `\graphicspath` and extract paths.
- Updated logic to normalize and check figure paths within the specified graphicspaths.
- Added logging to `create_image_message` in `message_utils.py` for used images.
- Removed unused import in `adapt.py`, `paper2note.py`, and `txt2tex.py`.

## [0.7.10]

- Removed redundant comments and unused imports.
- Simplified function definitions and improved readability.
- Consolidated model settings and prompt settings retrieval.
- Enhanced logging and error handling.
- Updated function signatures for consistency.
- Improved handling of file paths and content extraction.

## [0.7.9]

- Refactored continuation logic for improved handling of existing files
- Implemented new has_end_tag function to check for end tags in file content
- Removed append_mode from output settings and related command-line arguments
- Improved handling of existing files in both initial and reflection rounds
- Enhanced "continue to reflect" functionality
- Various code cleanup and minor improvements

## [0.7.8]

- Refactored settings and prompt handling for improved modularity and consistency
- Introduced centralized functions in settings_utils.py for model, output, and prompt settings
- Renamed 'first_prefill' to 'prefill_first' across all files for clarity
- Updated all task files to use new settings and prompt utilities
- Improved error handling and removed redundant code
- Enhanced code readability and maintainability

## [0.7.7]

- Refactored codebase for improved modularity and organization
- Split functionality into separate modules (tex_tools, figure_tools, etc.)
- Renamed process_file_with_llm to process_first_round for clarity
- Moved common utilities to dedicated files (arg_utils, prompt_utils)
- Updated imports across all tasks to use new module structure
- Standardized function naming and parameter passing
- Removed redundant code and consolidated shared functionality
- Improved consistency in logging and error handling

## [0.7.6]

- Refactored codebase for improved modularity and organization
- Split functionality into separate modules (tex_tools, figure_tools, etc.)
- Renamed process_file_with_llm to process_first_round for clarity
- Moved common utilities to dedicated files (arg_utils, prompt_utils)
- Updated imports across all tasks to use new module structure
- Standardized function naming and parameter passing
- Removed redundant code and consolidated shared functionality
- Improved consistency in logging and error handling

## [0.7.5]

- Refactored codebase for improved modularity and maintainability
- Created new `log_utils.py` for centralized logging functionality
- Moved `handle_reflection` function from `edit_utils.py` to `process.py`
- Updated all program files to use new logging utilities
- Improved error handling and input validation across multiple scripts
- Enhanced `log_start` function to include more detailed information
- Adjusted checkbox group styling in VS Code extension
- Various minor improvements and bug fixes

## [0.7.4]

- Fix the broken backend
- Created new `edit_utils.py` for shared edit functionality
- Refactored `adapt.py`, `lecture2text.py`, `meeting2text.py`, `merge.py`, `paper2note.py`, `prl_edit.py`, `prl_reply.py`, and `txt2tex.py` to use shared utilities
- Updated `model_utils.py` for improved image handling
- Enhanced error handling and input validation across multiple scripts
- Improved code readability and maintainability
- Updated version to 0.7.4 in `pyproject.toml`
- Various minor improvements and bug fixes

## [0.7.3]

- Created new edit_utils.py file for shared edit functionality
- Refactored edit_lecture.py and edit_tex.py to use shared utilities
- Updated model_utils.py for improved image handling
- Enhanced error handling and input validation
- Improved code readability and maintainability
- Various minor improvements and bug fixes

## [0.7.2]

- Extensively refactored process.py for improved code organization and maintainability:
  - Separated file processing logic into dedicated functions
  - Enhanced error handling with specific exception catching
  - Added comprehensive type hints throughout the file
  - Reorganized and optimized import statements
  - Created new helper functions to reduce code duplication
- Added --auto_extract_figure option to automatically extract figure paths from input files
- Added --include_tex_count option to include tex count statistics in user messages
- Updated CLI commands to support new options
- Improved error handling and logging for better user feedback and debugging
- Various minor improvements and bug fixes

## [0.7.1]

- Bumped version to 0.7.1
- Updated Python target versions to include Python 3.12
- Various minor improvements and bug fixes
- Added TikZ extractor update

## [0.7.0]

- Added new merge functionality for LaTeX documents
- Implemented merge command in CLI
- Created merge.py program for merging LaTeX documents
- Added prompts for merge functionality
- Updated model_utils for improved image handling
- Bumped version to 0.7.0
- Updated Python target versions to include Python 3.12
- Various minor improvements and bug fixes.
- Various minor improvements and bug fixes.
