# DOM ID Helpers

The `@common/domIdUtils` module centralizes DOM id generation.
Use these helpers instead of hand-written template literals to
ensure consistent naming across modules.

| Function                            | Purpose                                                | Example                             |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `getSingleFileId(type)`             | ID for single-file select elements                     | `input` → `inputFile`               |
| `getMultipleFilesId(type)`          | ID for multi-file list elements                        | `output` → `outputFiles`            |
| `getMultipleFilesContainerId(type)` | ID for multi-file containers                           | `media` → `mediaFilesContainer`     |
| `getToggleId(id)`                   | ID for toggle elements controlling a list or container | `outputFiles` → `toggleOutputFiles` |

Always prefer these helpers when manipulating related DOM elements
so future code remains easy to follow and maintain.
