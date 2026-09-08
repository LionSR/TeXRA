#define NAPI_VERSION 8
#include <node_api.h>

#include <stdlib.h>
#include <string.h>

#include "cleanup.h"

static const napi_type_tag root_tag = {0x924ed701eac44673ULL,
                                       0xb87ddca2f10ae195ULL};

static napi_status cleanup_unwrap_root(napi_env env, napi_value value,
                                cleanup_root **root) {
  bool matches = false;
  napi_status status =
      napi_check_object_type_tag(env, value, &root_tag, &matches);
  if (status != napi_ok || !matches)
    return napi_invalid_arg;
  return napi_unwrap(env, value, (void **)root);
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  cleanup_root *root;
  char *directory;
  char **ids;
  size_t count;
  cleanup_error error;
  int result;
} remove_work;

static napi_value native_error(napi_env env, const cleanup_error *failure) {
  napi_value code, message, error;
  napi_create_string_utf8(env, failure->code, NAPI_AUTO_LENGTH, &code);
  napi_create_string_utf8(env, failure->message, NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, code, message, &error);
  return error;
}

static char *read_string(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a filesystem name string.");
    return NULL;
  }
  char *text = malloc(length + 1);
  if (text == NULL) {
    napi_throw_error(env, "ENOMEM", "Cannot allocate a filesystem name.");
    return NULL;
  }
  if (napi_get_value_string_utf8(env, value, text, length + 1, &length) !=
          napi_ok ||
      memchr(text, '\0', length) != NULL) {
    free(text);
    napi_throw_type_error(env, NULL, "Filesystem names cannot contain NUL.");
    return NULL;
  }
  return text;
}

static void finalize_root(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  cleanup_close_root(data);
}

/* Admit the directory capability synchronously; traversal uses async work. */
static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1) {
    napi_throw_type_error(env, NULL, "Expected the storage-directory path.");
    return NULL;
  }
  char *path = read_string(env, args[0]);
  if (path == NULL)
    return NULL;
  cleanup_root *root;
  cleanup_error error;
  int result = cleanup_open_root(path, &root, &error);
  free(path);
  if (result != 0) {
    napi_throw(env, native_error(env, &error));
    return NULL;
  }
  napi_value value;
  if (napi_create_object(env, &value) != napi_ok ||
      napi_type_tag_object(env, value, &root_tag) != napi_ok ||
      napi_wrap(env, value, root, finalize_root, NULL, NULL) != napi_ok) {
    cleanup_close_root(root);
    napi_throw_error(env, NULL,
                     "Cannot expose the storage-directory capability.");
    return NULL;
  }
  return value;
}

static void free_remove(remove_work *work) {
  for (size_t index = 0; index < work->count; index++)
    free(work->ids[index]);
  free(work->ids);
  free(work->directory);
  if (work->root != NULL)
    cleanup_close_root(work->root);
  free(work);
}

static void execute_remove(napi_env env, void *data) {
  (void)env;
  remove_work *work = data;
  work->result = cleanup_remove_runs(work->root, work->directory,
                                     (const char *const *)work->ids,
                                     work->count, &work->error);
}

static void complete_remove(napi_env env, napi_status status, void *data) {
  remove_work *work = data;
  if (status != napi_ok || work->result != 0) {
    const cleanup_error cancelled = {
        "ECANCELED", "Generated-directory removal was cancelled."};
    napi_reject_deferred(
        env, work->deferred,
        native_error(env, status == napi_ok ? &work->error : &cancelled));
  } else {
    napi_value value;
    napi_get_undefined(env, &value);
    napi_resolve_deferred(env, work->deferred, value);
  }
  napi_delete_async_work(env, work->work);
  free_remove(work);
}

static napi_value remove_runs(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  cleanup_root *root;
  uint32_t length;
  if (count != 3 || napi_get_array_length(env, args[2], &length) != napi_ok) {
    napi_throw_type_error(env, NULL,
                          "Expected a held directory and execution names.");
    return NULL;
  }
  remove_work *work = calloc(1, sizeof(*work));
  if (work == NULL) {
    napi_throw_error(env, "ENOMEM", "Cannot allocate directory removal.");
    return NULL;
  }
  work->directory = read_string(env, args[1]);
  if (work->directory == NULL) {
    free(work);
    return NULL;
  }
  if (*work->directory == '\0' || strchr(work->directory, '/') != NULL ||
      strchr(work->directory, '\\') != NULL ||
      strchr(work->directory, ':') != NULL ||
      strcmp(work->directory, ".") == 0 || strcmp(work->directory, "..") == 0) {
    free_remove(work);
    napi_throw_type_error(env, NULL, "Expected one generated-directory name.");
    return NULL;
  }
  work->ids = calloc(length == 0 ? 1 : length, sizeof(char *));
  if (work->ids == NULL) {
    free_remove(work);
    napi_throw_error(env, "ENOMEM", "Cannot allocate execution names.");
    return NULL;
  }
  work->count = length;
  for (uint32_t index = 0; index < length; index++) {
    napi_value value;
    if (napi_get_element(env, args[2], index, &value) != napi_ok) {
      free_remove(work);
      return NULL;
    }
    char *id = read_string(env, value);
    work->ids[index] = id;
    if (id == NULL) {
      free_remove(work);
      return NULL;
    }
    /* The native capability accepts one child name, never a pathname. */
    if (*id == '\0' || strchr(id, '/') != NULL || strchr(id, '\\') != NULL ||
        strchr(id, ':') != NULL || strcmp(id, ".") == 0 ||
        strcmp(id, "..") == 0) {
      free_remove(work);
      napi_throw_type_error(env, NULL,
                            "An execution must be one directory name.");
      return NULL;
    }
  }
  /* Argument getters may close the caller root. Acquire only after those
   * callbacks have returned, before scheduling any native operation. */
  if (cleanup_unwrap_root(env, args[0], &root) != napi_ok) {
    free_remove(work);
    napi_throw_type_error(env, NULL, "Expected an open storage directory.");
    return NULL;
  }
  /* The worker owns its own directory capability. Closing the caller's root
   * cannot release or reuse the descriptor used by queued filesystem work. */
  if (cleanup_clone_root(root, &work->root, &work->error) < 0) {
    napi_value error = native_error(env, &work->error);
    free_remove(work);
    napi_throw(env, error);
    return NULL;
  }
  napi_value promise, name;
  napi_status status = napi_create_promise(env, &work->deferred, &promise);
  if (status == napi_ok)
    status = napi_create_string_utf8(env, "TeXRA remove generated directories",
                                     NAPI_AUTO_LENGTH, &name);
  if (status == napi_ok)
    status = napi_create_async_work(env, NULL, name, execute_remove,
                                    complete_remove, work, &work->work);
  if (status == napi_ok)
    status = napi_queue_async_work(env, work->work);
  if (status != napi_ok) {
    if (work->work != NULL)
      napi_delete_async_work(env, work->work);
    free_remove(work);
    napi_throw_error(env, NULL, "Cannot schedule directory removal.");
    return NULL;
  }
  return promise;
}

static napi_value close_root(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  cleanup_root *root;
  if (count != 1 || cleanup_unwrap_root(env, args[0], &root) != napi_ok ||
      napi_remove_wrap(env, args[0], (void **)&root) != napi_ok) {
    napi_throw_type_error(env, NULL,
                          "Expected an open generated-directory handle.");
    return NULL;
  }
  cleanup_close_root(root);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
      {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
      {"removeExecutionDirectories", NULL, remove_runs, NULL, NULL, NULL,
       napi_default, NULL},
      {"closeRoot", NULL, close_root, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]),
                         methods);
  return exports;
}
