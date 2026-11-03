# deepseek/deepseek-flash, 2026-11-03

Harness 0.1.0 from the packed tarball at `14d0e110f7`, Node v26.13.0.
Spend reported by the runs: $0.0123.

| Scenario | Result | Runs | Scripts (failed) | Tokens in/out | Cost (USD) | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| codemode | pass | 3 | 6 (1) | 65206/5115 | 0.0051 | 42 |
| plugin | pass | 1 | 3 (1) | 12084/686 | 0.0009 | 8 |
| crash-resume | pass | 4 | 2 (1) | 41029/8181 | 0.0064 | 58 |

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
