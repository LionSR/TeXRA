# CoAuthor

CoAuthor is a Python package containing utility functions for copiloting with large language models (LLMs) like Anthropic's Claude AI for academic research. It provides a command-line interface (CLI) to perform various text processing and generation tasks.

## Installation

To install the python backedn of CoAuthor, download the latest release and run
```bash
pip install -e .
```


## Changelog

### 0.7.2 [backend]
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

### 0.7.1 [backend] 
- Bumped version to 0.7.1
- Updated Python target versions to include Python 3.12
- Various minor improvements and bug fixes
- Added TikZ extractor update

### 0.7.0 [backend] 
- Added new merge functionality for LaTeX documents
- Implemented merge command in CLI
- Created merge.py program for merging LaTeX documents
- Added prompts for merge functionality
- Updated model_utils for improved image handling
- Bumped version to 0.7.0
- Updated Python target versions to include Python 3.12
- Various minor improvements and bug fixes