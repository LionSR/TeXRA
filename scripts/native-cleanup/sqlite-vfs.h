#ifndef TEXRA_SQLITE_VFS_H
#define TEXRA_SQLITE_VFS_H

#include "cleanup.h"
#include <sqlite3ext.h>

/* One explicit VFS belongs to one connection and holds its cloned root.
 * The parent provides time/randomness only; filesystem operations never
 * delegate to its pathname-based implementation. */
typedef struct {
  cleanup_root *root;
  const sqlite3_api_routines *api;
  sqlite3_vfs *parent;
} rooted_sqlite_vfs_context;

/* Configure szOsFile, xOpen, xDelete and xAccess, plus any platform-specific
 * diagnostics. pAppData points to context. Common code owns registration,
 * logical xFullPathname, non-filesystem callbacks, and context lifetime.
 * xOpen must support SQLite-owned anonymous temporary files (name == NULL)
 * in the held directory, including DELETEONCLOSE semantics. */
int rooted_sqlite_platform_admit(cleanup_root *root, cleanup_error *error);

void rooted_sqlite_platform_vfs(sqlite3_vfs *vfs,
                                rooted_sqlite_vfs_context *context);

typedef struct {
  sqlite3 *handle;
  rooted_sqlite_vfs_context context;
  sqlite3_vfs vfs;
  char name[64];
} rooted_sqlite_database;

int rooted_sqlite_open(cleanup_root *root, const char *filename,
                       const sqlite3_api_routines *api,
                       rooted_sqlite_database **out, cleanup_error *error);
/* A BUSY close leaves the connection and its resource ownership intact. */
int rooted_sqlite_close(rooted_sqlite_database *database);

#endif
