# attic/

Preserved sources under the keep-not-delete convention: code retired from the
active tree that we deliberately keep checked in, verbatim, for possible future
restoration. Nothing here is compiled, linted, type checked, tested, formatted,
or deployed — every build and check glob excludes this directory (and
`.prettierignore` lists it explicitly).

Each subdirectory carries its own README naming the pre-removal commit SHA it
was lifted from and the recovery document that explains how to restore it. Do
not import from `attic/` and do not "fix" code here; it is a snapshot, and its
only consumer is a human doing a restoration.
