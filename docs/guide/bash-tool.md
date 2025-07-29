# Bash Tool

TeXRA includes a `bash` tool that lets agents execute shell commands within your workspace. The
session is persistent, meaning commands share the same environment and working directory.

## Usage

The tool accepts either a `command` to run or a `restart` flag:

```json
{ "command": "ls" }
{ "restart": true }
```

Use `restart` to start a fresh shell session. A typical workflow might change directories and run
subsequent commands that rely on that state. Restarting resets the working directory and clears
any environment variables set during the session.

Outputs longer than 100 lines are truncated to avoid flooding the log. Potentially dangerous
commands like `rm -rf /` are blocked.

## Example

```json
{ "command": "cd data && ls" }
```

Calling the tool again with `pwd` will show `data` because the session kept the directory change.
Use `{ "restart": true }` if you need to reset the environment.
