#include "sqlite-native.h"
#include "sqlite-vfs.h"

#include <math.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <stdatomic.h>
#endif
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* SQLite's documented extension entry supplies the host engine's API table.
 * Each connection retains its table. No engine or private Node ABI is linked.
 */
#ifdef _WIN32
static const sqlite3_api_routines *volatile host_api;
#else
static _Atomic(const sqlite3_api_routines *) host_api;
#endif
#ifdef _WIN32
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int sqlite3_extension_init(sqlite3 *database, char **error,
                           const sqlite3_api_routines *api) {
  (void)database;
  (void)error;
#ifdef _WIN32
  InterlockedExchangePointer((void *volatile *)&host_api, (void *)api);
#else
  atomic_store_explicit(&host_api, api, memory_order_release);
#endif
  return SQLITE_OK;
}

static const napi_type_tag database_tag = {0x1e1736c78ae04942ULL,
                                           0xafe8b1d4b385a37cULL};

static int js_ok(napi_env env, napi_status status) {
  if (status == napi_ok)
    return 1;
  if (status != napi_pending_exception)
    napi_throw_error(env, NULL, "Cannot construct the native SQLite result.");
  return 0;
}

static void throw_sqlite(napi_env env, const sqlite3_api_routines *api,
                         sqlite3 *database, int result, const char *message) {
  int code = database == NULL ? result : api->extended_errcode(database);
  napi_value error, text, value;
  if (code == SQLITE_OK)
    code = result;
  if (message == NULL)
    message = database == NULL ? api->errstr(result) : api->errmsg(database);
  if (!js_ok(env,
             napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text)) ||
      !js_ok(env, napi_create_error(env, NULL, text, &error)))
    return;
  napi_create_string_utf8(env, "ERR_SQLITE_ERROR", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "code", value);
  napi_create_int32(env, code, &value);
  napi_set_named_property(env, error, "errcode", value);
  napi_set_named_property(env, error, "errno", value);
  napi_create_string_utf8(env, api->errstr(code), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "errstr", value);
  napi_throw(env, error);
}

static char *text_value(napi_env env, napi_value value, size_t *length) {
  if (napi_get_value_string_utf8(env, value, NULL, 0, length) != napi_ok) {
    napi_throw_type_error(env, NULL, "SQLite text must be a string.");
    return NULL;
  }
  char *text = malloc(*length + 1);
  if (text == NULL) {
    napi_throw_error(env, "ENOMEM", "Cannot allocate SQLite text.");
    return NULL;
  }
  if (!js_ok(env, napi_get_value_string_utf8(env, value, text, *length + 1,
                                             length))) {
    free(text);
    return NULL;
  }
  return text;
}

static int unwrap_database(napi_env env, napi_value value,
                           rooted_sqlite_database **database) {
  bool matches = false;
  if (napi_check_object_type_tag(env, value, &database_tag, &matches) !=
          napi_ok ||
      !matches || napi_unwrap(env, value, (void **)database) != napi_ok) {
    napi_throw_type_error(env, NULL,
                          "Expected an open native SQLite connection.");
    return 0;
  }
  return 1;
}

static int integer_value(napi_env env, sqlite3_int64 value, bool big,
                         napi_value *out) {
  if (big)
    return js_ok(env, napi_create_bigint_int64(env, value, out));
  if (value < -9007199254740991LL || value > 9007199254740991LL) {
    napi_throw_range_error(
        env, NULL, "SQLite integer cannot be represented safely as a number.");
    return 0;
  }
  return js_ok(env, napi_create_double(env, (double)value, out));
}

static int bind_value(napi_env env, rooted_sqlite_database *database,
                      sqlite3_stmt *statement, int index, napi_value value) {
  const sqlite3_api_routines *api = database->context.api;
  napi_valuetype type;
  if (!js_ok(env, napi_typeof(env, value, &type)))
    return 0;
  int result;
  switch (type) {
  case napi_null:
    result = api->bind_null(statement, index);
    break;
  case napi_number: {
    double number;
    if (!js_ok(env, napi_get_value_double(env, value, &number)))
      return 0;
    result = api->bind_double(statement, index, number);
    break;
  }
  case napi_bigint: {
    int64_t number;
    bool lossless;
    if (!js_ok(env,
               napi_get_value_bigint_int64(env, value, &number, &lossless)))
      return 0;
    if (!lossless) {
      napi_throw_range_error(
          env, NULL, "SQLite bigint is outside the signed 64-bit range.");
      return 0;
    }
    result = api->bind_int64(statement, index, number);
    break;
  }
  case napi_string: {
    size_t length;
    char *text = text_value(env, value, &length);
    if (text == NULL)
      return 0;
    result = api->bind_text64(statement, index, text, length, SQLITE_TRANSIENT,
                              SQLITE_UTF8);
    free(text);
    break;
  }
  case napi_object: {
    bool typed, view;
    if (!js_ok(env, napi_is_typedarray(env, value, &typed)) ||
        !js_ok(env, napi_is_dataview(env, value, &view)))
      return 0;
    void *data;
    size_t length, offset;
    napi_value buffer;
    if (typed) {
      napi_typedarray_type kind;
      if (!js_ok(env, napi_get_typedarray_info(env, value, &kind, &length,
                                               &data, &buffer, &offset)))
        return 0;
      switch (kind) {
      case napi_int8_array:
      case napi_uint8_array:
      case napi_uint8_clamped_array:
        break;
      case napi_int16_array:
      case napi_uint16_array:
        length *= 2;
        break;
      case napi_int32_array:
      case napi_uint32_array:
      case napi_float32_array:
        length *= 4;
        break;
      case napi_float64_array:
      case napi_bigint64_array:
      case napi_biguint64_array:
        length *= 8;
        break;
      }
    } else if (view) {
      if (!js_ok(env, napi_get_dataview_info(env, value, &length, &data,
                                             &buffer, &offset)))
        return 0;
    } else {
      napi_throw_type_error(env, NULL,
                            "SQLite bindings must be strings, numbers, "
                            "bigints, null or byte views.");
      return 0;
    }
    /* A zero-byte blob is distinct from SQL NULL even if its data is NULL. */
    result = length == 0 ? api->bind_zeroblob(statement, index, 0)
                         : api->bind_blob64(statement, index, data, length,
                                            SQLITE_TRANSIENT);
    break;
  }
  default:
    napi_throw_type_error(env, NULL,
                          "SQLite bindings must be strings, numbers, bigints, "
                          "null or byte views.");
    return 0;
  }
  if (result == SQLITE_OK)
    return 1;
  throw_sqlite(env, api, database->handle, result, NULL);
  return 0;
}

static int column_value(napi_env env, const sqlite3_api_routines *api,
                        sqlite3_stmt *statement, int column, bool big,
                        napi_value *out) {
  switch (api->column_type(statement, column)) {
  case SQLITE_NULL:
    return js_ok(env, napi_get_null(env, out));
  case SQLITE_INTEGER:
    return integer_value(env, api->column_int64(statement, column), big, out);
  case SQLITE_FLOAT:
    return js_ok(env, napi_create_double(
                          env, api->column_double(statement, column), out));
  case SQLITE_TEXT:
    return js_ok(env,
                 napi_create_string_utf8(
                     env, (const char *)api->column_text(statement, column),
                     (size_t)api->column_bytes(statement, column), out));
  case SQLITE_BLOB: {
    size_t length = (size_t)api->column_bytes(statement, column);
    napi_value buffer;
    void *data;
    if (!js_ok(env, napi_create_arraybuffer(env, length, &data, &buffer)))
      return 0;
    if (length > 0)
      memcpy(data, api->column_blob(statement, column), length);
    return js_ok(env, napi_create_typedarray(env, napi_uint8_array, length,
                                             buffer, 0, out));
  }
  }
  napi_throw_error(env, NULL, "Unexpected SQLite column type.");
  return 0;
}

static napi_value query(napi_env env, napi_callback_info info, bool arrays) {
  napi_value args[3], receiver;
  size_t count = 3;
  if (!js_ok(env, napi_get_cb_info(env, info, &count, args, &receiver, NULL)))
    return NULL;
  if (count < 2) {
    napi_throw_type_error(env, NULL, "Expected SQL and a binding array.");
    return NULL;
  }
  bool big = false;
  if (count > 2) {
    napi_valuetype type;
    if (!js_ok(env, napi_typeof(env, args[2], &type)))
      return NULL;
    if (type != napi_undefined) {
      napi_value option;
      if (!js_ok(env, napi_get_named_property(env, args[2], "safeIntegers",
                                              &option)) ||
          !js_ok(env, napi_typeof(env, option, &type)))
        return NULL;
      if (type != napi_undefined &&
          !js_ok(env, napi_get_value_bool(env, option, &big)))
        return NULL;
    }
  }
  bool is_array;
  uint32_t bindings;
  if (!js_ok(env, napi_is_array(env, args[1], &is_array)))
    return NULL;
  if (!is_array) {
    napi_throw_type_error(env, NULL, "SQLite bindings must be an array.");
    return NULL;
  }
  if (!js_ok(env, napi_get_array_length(env, args[1], &bindings)))
    return NULL;
  if (bindings > INT32_MAX) {
    napi_throw_range_error(env, NULL, "Too many SQLite bindings.");
    return NULL;
  }
  size_t length;
  char *sql = text_value(env, args[0], &length);
  if (sql == NULL)
    return NULL;
  rooted_sqlite_database *database;
  if (!unwrap_database(env, receiver, &database)) {
    free(sql);
    return NULL;
  }
  const sqlite3_api_routines *api = database->context.api;
  sqlite3_stmt *statement = NULL;
  int result = api->prepare_v2(database->handle, sql, -1, &statement, NULL);
  free(sql);
  if (result != SQLITE_OK) {
    throw_sqlite(env, api, database->handle, result, NULL);
    return NULL;
  }
  if (statement == NULL) {
    napi_throw_type_error(env, NULL, "Expected a SQLite statement.");
    return NULL;
  }
  /* A live statement also prevents a reentrant explicit close from freeing
   * this connection while a binding array getter is executing. */
  for (uint32_t index = 0; index < bindings; index++) {
    napi_value value;
    if (!js_ok(env, napi_get_element(env, args[1], index, &value)) ||
        !bind_value(env, database, statement, (int)index + 1, value)) {
      api->finalize(statement);
      return NULL;
    }
  }
  napi_value rows;
  if (!js_ok(env, napi_create_array(env, &rows))) {
    api->finalize(statement);
    return NULL;
  }
  uint32_t row_index = 0;
  while ((result = api->step(statement)) == SQLITE_ROW) {
    napi_value row;
    int columns = api->column_count(statement);
    napi_status status = arrays
                             ? napi_create_array_with_length(env, columns, &row)
                             : napi_create_object(env, &row);
    if (!js_ok(env, status)) {
      api->finalize(statement);
      return NULL;
    }
    for (int column = 0; column < columns; column++) {
      napi_value value;
      if (!column_value(env, api, statement, column, big, &value)) {
        api->finalize(statement);
        return NULL;
      }
      if (arrays)
        status = napi_set_element(env, row, column, value);
      else {
        napi_property_descriptor property = {
            .utf8name = api->column_name(statement, column),
            .value = value,
            .attributes = napi_writable | napi_enumerable | napi_configurable};
        status = napi_define_properties(env, row, 1, &property);
      }
      if (!js_ok(env, status)) {
        api->finalize(statement);
        return NULL;
      }
    }
    if (!js_ok(env, napi_set_element(env, rows, row_index++, row))) {
      api->finalize(statement);
      return NULL;
    }
  }
  if (result != SQLITE_DONE) {
    throw_sqlite(env, api, database->handle, result, NULL);
    api->finalize(statement);
    return NULL;
  }
  sqlite3_int64 changes = api->changes64(database->handle);
  sqlite3_int64 inserted = api->last_insert_rowid(database->handle);
  result = api->finalize(statement);
  if (result != SQLITE_OK) {
    throw_sqlite(env, api, database->handle, result, NULL);
    return NULL;
  }
  if (arrays)
    return rows;
  napi_value out, change_value, inserted_value;
  if (!integer_value(env, changes, false, &change_value) ||
      !integer_value(env, inserted, big, &inserted_value) ||
      !js_ok(env, napi_create_object(env, &out)) ||
      !js_ok(env, napi_set_named_property(env, out, "rows", rows)) ||
      !js_ok(env, napi_set_named_property(env, out, "changes", change_value)) ||
      !js_ok(env, napi_set_named_property(env, out, "lastInsertRowid",
                                          inserted_value)))
    return NULL;
  return out;
}

static napi_value execute(napi_env env, napi_callback_info info) {
  return query(env, info, false);
}
static napi_value values(napi_env env, napi_callback_info info) {
  return query(env, info, true);
}

static napi_value exec(napi_env env, napi_callback_info info) {
  napi_value args[1], receiver, out;
  size_t count = 1, length;
  if (!js_ok(env, napi_get_cb_info(env, info, &count, args, &receiver, NULL)))
    return NULL;
  if (count != 1) {
    napi_throw_type_error(env, NULL, "Expected SQL text.");
    return NULL;
  }
  char *sql = text_value(env, args[0], &length);
  if (sql == NULL)
    return NULL;
  rooted_sqlite_database *database;
  if (!unwrap_database(env, receiver, &database)) {
    free(sql);
    return NULL;
  }
  const sqlite3_api_routines *api = database->context.api;
  char *error = NULL;
  int result = api->exec(database->handle, sql, NULL, NULL, &error);
  free(sql);
  if (result != SQLITE_OK) {
    throw_sqlite(env, api, database->handle, result, error);
    api->free(error);
    return NULL;
  }
  napi_get_undefined(env, &out);
  return out;
}

static void finalize_database(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  /* Statements never escape a synchronous operation, and its receiver is
   * reachable until that operation returns. */
  (void)rooted_sqlite_close(data);
}

static napi_value close_database(napi_env env, napi_callback_info info) {
  napi_value receiver, out;
  rooted_sqlite_database *database;
  if (!js_ok(env, napi_get_cb_info(env, info, NULL, NULL, &receiver, NULL)) ||
      !unwrap_database(env, receiver, &database))
    return NULL;
  const sqlite3_api_routines *api = database->context.api;
  int result = rooted_sqlite_close(database);
  if (result != SQLITE_OK) {
    throw_sqlite(env, api, database->handle, result, NULL);
    return NULL;
  }
  if (!js_ok(env, napi_remove_wrap(env, receiver, (void **)&database)))
    return NULL;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value expose_database(napi_env env, cleanup_root *root,
                                  const char *filename) {
#ifdef _WIN32
  const sqlite3_api_routines *api = InterlockedCompareExchangePointer(
      (void *volatile *)&host_api, NULL, NULL);
#else
  const sqlite3_api_routines *api =
      atomic_load_explicit(&host_api, memory_order_acquire);
#endif
  if (api == NULL) {
    napi_throw_error(env, NULL,
                     "The host SQLite interface has not been loaded.");
    return NULL;
  }
  rooted_sqlite_database *database = NULL;
  cleanup_error error = {0};
  int result = rooted_sqlite_open(root, filename, api, &database, &error);
  if (result != SQLITE_OK) {
    throw_sqlite(env, api, database == NULL ? NULL : database->handle, result,
                 error.message[0] == '\0' ? NULL : error.message);
    rooted_sqlite_close(database);
    return NULL;
  }
  napi_value out;
  napi_property_descriptor methods[] = {
      {"execute", NULL, execute, NULL, NULL, NULL, napi_default, NULL},
      {"values", NULL, values, NULL, NULL, NULL, napi_default, NULL},
      {"exec", NULL, exec, NULL, NULL, NULL, napi_default, NULL},
      {"close", NULL, close_database, NULL, NULL, NULL, napi_default, NULL},
  };
  if (!js_ok(env, napi_create_object(env, &out)) ||
      !js_ok(env, napi_type_tag_object(env, out, &database_tag)) ||
      !js_ok(env, napi_define_properties(env, out, 4, methods)) ||
      !js_ok(env,
             napi_wrap(env, out, database, finalize_database, NULL, NULL))) {
    rooted_sqlite_close(database);
    return NULL;
  }
  return out;
}

static napi_value open_database(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t count = 2, length;
  if (!js_ok(env, napi_get_cb_info(env, info, &count, args, NULL, NULL)))
    return NULL;
  if (count != 2) {
    napi_throw_type_error(env, NULL, "Expected a root and database filename.");
    return NULL;
  }
  char *filename = text_value(env, args[1], &length);
  if (filename == NULL)
    return NULL;
  if (length == 0 || memchr(filename, '\0', length) != NULL ||
      strchr(filename, '/') != NULL || strchr(filename, '\\') != NULL ||
      strchr(filename, ':') != NULL || strcmp(filename, ".") == 0 ||
      strcmp(filename, "..") == 0) {
    free(filename);
    napi_throw_type_error(env, NULL,
                          "Expected one persistent database filename.");
    return NULL;
  }
  cleanup_root *root;
  if (cleanup_unwrap_root(env, args[0], &root) != napi_ok) {
    free(filename);
    napi_throw_type_error(env, NULL,
                          "Expected an open storage-directory capability.");
    return NULL;
  }
  napi_value out = expose_database(env, root, filename);
  free(filename);
  return out;
}

static napi_value open_memory_database(napi_env env, napi_callback_info info) {
  (void)info;
  return expose_database(env, NULL, ":memory:");
}

napi_status rooted_sqlite_exports(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"openDatabase", NULL, open_database, NULL, NULL, NULL, napi_default,
       NULL},
      {"openMemoryDatabase", NULL, open_memory_database, NULL, NULL, NULL,
       napi_default, NULL},
  };
  return napi_define_properties(env, exports, 2, methods);
}
