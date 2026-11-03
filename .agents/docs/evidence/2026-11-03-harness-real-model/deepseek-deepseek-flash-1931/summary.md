# deepseek/deepseek-flash, 2026-11-03

Harness 0.1.0 from the packed tarball at `171aa36b38`, Node v26.12.1.
Spend reported by the runs: $0.0144.

| Scenario | Result | Runs | Scripts (failed) | Tokens in/out | Cost (USD) | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| codemode | fail | 5 | 10 (1) | 197858/8278 | 0.0081 | 70 |
| plugin | pass | 1 | 3 (0) | 14394/881 | 0.0011 | 11 |
| crash-resume | fail | 5 | 1 (0) | 21208/6594 | 0.0052 | 481 |

## codemode

- pass: run completed
- pass: a script finished
- pass: the module called the plugin tool
- pass: two self() rounds completed
- pass: each round ended with a structured verdict naming a section
- pass: an executions SQL query succeeded
- FAIL: the script returned every section title ([["e70fec1f90d6d79e7399d489","ended","completed"],["635cc379c82276ef453b5e67","ended","completed"],["44cc4980082b740fb6eb099e","ended","completed"],["e97758d9ce2271c1caa32a13","ended","completed"]])
- FAIL: the returned count matches the finished children ({"completed":4,"returned":[["e70fec1f90d6d79e7399d489","ended","completed"],["635cc379c82276ef453b5e67","ended","completed"],["44cc4980082b740fb6eb099e","ended","completed"],["e97758d9ce2271c1caa32a13","ended","completed"]]})

## plugin

- pass: run completed
- pass: a script imported the notes module
- pass: note_add ran from a script
- pass: both notes are versioned facts of the plugin
- pass: the script returned both notes

## crash-resume

- FAIL: the script reached a committed self() result and a pending sign-off (self ended: false, sign-off started: true, crash process killed at the time limit)
