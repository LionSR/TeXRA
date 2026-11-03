# deepseek/deepseek-flash, 2026-11-03

Harness 0.1.0 from the packed tarball at `171aa36b38`, Node v26.12.1.
Spend reported by the runs: $0.0129.

| Scenario | Result | Runs | Scripts (failed) | Tokens in/out | Cost (USD) | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| codemode | pass | 3 | 5 (1) | 61730/5395 | 0.0053 | 35 |
| plugin | pass | 1 | 5 (1) | 21597/1376 | 0.0015 | 11 |
| crash-resume | pass | 4 | 5 (2) | 52103/7765 | 0.0062 | 47 |

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
- pass: exactly one round was committed before the kill
- pass: resumed run completed
- pass: committed children did not run again
- pass: a second round ran and completed after the resume
- pass: the interrupted script finished from its saved source
