# CoAuthor Backend

CoAuthor is a Python package containing utility functions for copiloting with large language models (LLMs) like Anthropic's Claude AI for academic research. It provides a command-line interface (CLI) to perform various text processing and generation tasks.

## Installation

To install the python backedn of CoAuthor, download the latest release and run
```bash
pip install -e .
```
Set `.env` to use the OpenAI and Anthropic API keys.

## Backend Changelog

### 0.8.0

- Added auto-extract TikZ figure functionality
- Improved figure path extraction, including support for `\graphicspath`
- Enhanced logging for figure-related operations
- Refactored figure handling code for better modularity
- Updated CLI to support new TikZ figure extraction option
- Improved error handling and debugging output for figure operations

### 0.7.11

- Enhanced `extract_figure_paths` function to also look under `\graphicspath` for figures.
- Added regular expression to match `\graphicspath` and extract paths.
- Updated logic to normalize and check figure paths within the specified graphicspaths.
- Added logging to `create_image_message` in `message_utils.py` for used images.
- Removed unused import in `adapt.py`, `paper2note.py`, and `txt2tex.py`.


### 0.7.10

- Removed redundant comments and unused imports.
- Simplified function definitions and improved readability.
- Consolidated model settings and prompt settings retrieval.
- Enhanced logging and error handling.
- Updated function signatures for consistency.
- Improved handling of file paths and content extraction.

### 0.7.9

- Refactored continuation logic for improved handling of existing files
- Implemented new has_end_tag function to check for end tags in file content
- Removed append_mode from output settings and related command-line arguments
- Improved handling of existing files in both initial and reflection rounds
- Enhanced "continue to reflect" functionality
- Various code cleanup and minor improvements

### 0.7.8

- Refactored settings and prompt handling for improved modularity and consistency
- Introduced centralized functions in settings_utils.py for model, output, and prompt settings
- Renamed 'first_prefill' to 'prefill_first' across all files for clarity
- Updated all task files to use new settings and prompt utilities
- Improved error handling and removed redundant code
- Enhanced code readability and maintainability

### 0.7.7

- Refactored codebase for improved modularity and organization
- Split functionality into separate modules (tex_tools, figure_tools, etc.)
- Renamed process_file_with_llm to process_first_round for clarity
- Moved common utilities to dedicated files (arg_utils, prompt_utils)
- Updated imports across all tasks to use new module structure
- Standardized function naming and parameter passing
- Removed redundant code and consolidated shared functionality
- Improved consistency in logging and error handling

### 0.7.6

- Refactored codebase for improved modularity and organization
- Split functionality into separate modules (tex_tools, figure_tools, etc.)
- Renamed process_file_with_llm to process_first_round for clarity
- Moved common utilities to dedicated files (arg_utils, prompt_utils)
- Updated imports across all tasks to use new module structure
- Standardized function naming and parameter passing
- Removed redundant code and consolidated shared functionality
- Improved consistency in logging and error handling

### 0.7.5

- Refactored codebase for improved modularity and maintainability
- Created new `log_utils.py` for centralized logging functionality
- Moved `handle_reflection` function from `edit_utils.py` to `process.py`
- Updated all program files to use new logging utilities
- Improved error handling and input validation across multiple scripts
- Enhanced `log_start` function to include more detailed information
- Adjusted checkbox group styling in VS Code extension
- Various minor improvements and bug fixes

### 0.7.4

- Fix the broken backend

### 0.7.4

- Created new `edit_utils.py` for shared edit functionality
- Refactored `adapt.py`, `lecture2text.py`, `meeting2text.py`, `merge.py`, `paper2note.py`, `prl_edit.py`, `prl_reply.py`, and `txt2tex.py` to use shared utilities
- Updated `model_utils.py` for improved image handling
- Enhanced error handling and input validation across multiple scripts
- Improved code readability and maintainability
- Updated version to 0.7.4 in `pyproject.toml`
- Various minor improvements and bug fixes

### 0.7.3

- Created new edit_utils.py file for shared edit functionality
- Refactored edit_lecture.py and edit_tex.py to use shared utilities
- Updated model_utils.py for improved image handling
- Enhanced error handling and input validation
- Improved code readability and maintainability
- Various minor improvements and bug fixes

### 0.7.2

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

### 0.7.1 

- Bumped version to 0.7.1
- Updated Python target versions to include Python 3.12
- Various minor improvements and bug fixes
- Added TikZ extractor update

### 0.7.0 

- Added new merge functionality for LaTeX documents
- Implemented merge command in CLI
- Created merge.py program for merging LaTeX documents
- Added prompts for merge functionality
- Updated model_utils for improved image handling
- Bumped version to 0.7.0
- Updated Python target versions to include Python 3.12
- Various minor improvements and bug fixes