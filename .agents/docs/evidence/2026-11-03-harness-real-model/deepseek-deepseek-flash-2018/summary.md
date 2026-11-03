# deepseek/deepseek-flash, 2026-11-03

Harness 0.1.0 from the packed tarball at `171aa36b38`, Node v26.12.1.
Spend reported by the runs: $0.0134.

| Scenario | Result | Runs | Scripts (failed) | Tokens in/out | Cost (USD) | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| codemode | pass | 3 | 3 (0) | 57461/5955 | 0.0056 | 40 |
| plugin | pass | 1 | 4 (1) | 16676/671 | 0.0010 | 7 |
| crash-resume | fail | 4 | 4 (2) | 68155/8579 | 0.0068 | 55 |

## codemode

- pass: run completed
- pass: a script finished
- pass: the module called the plugin tool
- pass: two self() rounds completed
- pass: each round ended with a structured verdict naming a section
- pass: an executions SQL query succeeded
- pass: the script returned every section title
- pass: the returned count matches the finished children

## plugin

- pass: run completed
- pass: a script imported the notes module
- pass: note_add ran from a script
- pass: both notes are versioned facts of the plugin
- pass: the script returned both notes

## crash-resume

- pass: killed by SIGKILL
- FAIL: exactly one round was committed before the kill (2)
- pass: resumed run completed
- pass: committed children did not run again
- pass: a second round ran and completed after the resume
- FAIL: the interrupted script finished from its saved source (failed)
