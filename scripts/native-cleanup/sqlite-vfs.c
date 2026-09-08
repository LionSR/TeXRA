#include "sqlite-vfs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static rooted_sqlite_vfs_context *context(sqlite3_vfs *vfs) {
  return vfs->pAppData;
}

/* SQLite names a database and its managed siblings inside one held directory.
 * The returned name is logical; no later callback resolves an ambient path. */
static int full_path(sqlite3_vfs *vfs, const char *name, int length,
                     char *out) {
  (void)vfs;
  if (name == NULL || *name == '\0' || strchr(name, '/') != NULL ||
      strchr(name, '\\') != NULL || strchr(name, ':') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0 ||
      strlen(name) >= (size_t)length)
    return SQLITE_CANTOPEN;
  memcpy(out, name, strlen(name) + 1);
  return SQLITE_OK;
}

static int randomness(sqlite3_vfs *vfs, int length, char *out) {
  rooted_sqlite_vfs_context *c = context(vfs);
  return c->parent->xRandomness(c->parent, length, out);
}

static int sleep_for(sqlite3_vfs *vfs, int microseconds) {
  rooted_sqlite_vfs_context *c = context(vfs);
  return c->parent->xSleep(c->parent, microseconds);
}

static int current_time(sqlite3_vfs *vfs, double *out) {
  rooted_sqlite_vfs_context *c = context(vfs);
  return c->parent->xCurrentTime(c->parent, out);
}

static int current_time_int64(sqlite3_vfs *vfs, sqlite3_int64 *out) {
  rooted_sqlite_vfs_context *c = context(vfs);
  return c->parent->xCurrentTimeInt64(c->parent, out);
}

static void release_resources(rooted_sqlite_database *database) {
  if (database->context.root != NULL) {
    database->context.api->vfs_unregister(&database->vfs);
    cleanup_close_root(database->context.root);
  }
  free(database);
}

int rooted_sqlite_open(cleanup_root *root, const char *filename,
                       const sqlite3_api_routines *api,
                       rooted_sqlite_database **out, cleanup_error *error) {
  rooted_sqlite_database *database = calloc(1, sizeof(*database));
  *out = database;
  if (database == NULL)
    return SQLITE_NOMEM;
  database->context.api = api;
  database->context.parent = api->vfs_find(NULL);
  const char *vfs_name = NULL;
  if (root != NULL) {
    if (cleanup_clone_root(root, &database->context.root, error) < 0 ||
        rooted_sqlite_platform_admit(database->context.root, error) < 0) {
      if (database->context.root != NULL)
        cleanup_close_root(database->context.root);
      free(database);
      *out = NULL;
      return SQLITE_CANTOPEN;
    }
    /* SQLite requires a unique registry name. It is never a filesystem name. */
    snprintf(database->name, sizeof(database->name), "texra-rooted-%p",
             (void *)database);
    database->vfs = (sqlite3_vfs){
        .iVersion = 2,
        .mxPathname = 255,
        .zName = database->name,
        .pAppData = &database->context,
        .xFullPathname = full_path,
        .xRandomness = randomness,
        .xSleep = sleep_for,
        .xCurrentTime = current_time,
        .xCurrentTimeInt64 = current_time_int64,
    };
    rooted_sqlite_platform_vfs(&database->vfs, &database->context);
    int result = api->vfs_register(&database->vfs, 0);
    if (result != SQLITE_OK) {
      cleanup_close_root(database->context.root);
      free(database);
      *out = NULL;
      return result;
    }
    vfs_name = database->name;
  }
  int result =
      api->open_v2(filename, &database->handle,
                   SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, vfs_name);
  if (result != SQLITE_OK)
    return result;
  /* These are the existing DatabaseSync options, now owned by this connection.
   */
  result =
      api->db_config(database->handle, SQLITE_DBCONFIG_ENABLE_FKEY, 1, NULL);
  if (result == SQLITE_OK)
    result = api->db_config(database->handle, SQLITE_DBCONFIG_DQS_DML, 0, NULL);
  if (result == SQLITE_OK)
    result = api->db_config(database->handle, SQLITE_DBCONFIG_DQS_DDL, 0, NULL);
  if (result == SQLITE_OK)
    result = api->db_config(database->handle,
                            SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0, NULL);
  return result;
}

int rooted_sqlite_close(rooted_sqlite_database *database) {
  if (database == NULL)
    return SQLITE_OK;
  int result = database->context.api->close(database->handle);
  if (result != SQLITE_OK)
    return result;
  release_resources(database);
  return SQLITE_OK;
}
