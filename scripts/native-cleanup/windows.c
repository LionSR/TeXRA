#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>

#include "cleanup.h"

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* These NT constants are absent from some user-mode SDK header versions. */
#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif

struct cleanup_root {
  HANDLE handle;
};

typedef struct {
  WCHAR *value;
  USHORT bytes;
} child_name;

typedef struct {
  HANDLE handle;
  child_name *names;
  size_t count;
  size_t next;
} directory_frame;

static int fail(cleanup_error *error, DWORD number) {
  const char *code = "EIO";
  switch (number) {
  case ERROR_FILE_NOT_FOUND:
  case ERROR_PATH_NOT_FOUND:
    code = "ENOENT";
    break;
  case ERROR_ACCESS_DENIED:
    code = "EACCES";
    break;
  case ERROR_SHARING_VIOLATION:
  case ERROR_LOCK_VIOLATION:
    code = "EBUSY";
    break;
  case ERROR_NOT_ENOUGH_MEMORY:
  case ERROR_OUTOFMEMORY:
    code = "ENOMEM";
    break;
  case ERROR_INVALID_NAME:
  case ERROR_INVALID_PARAMETER:
  case ERROR_NO_UNICODE_TRANSLATION:
    code = "EINVAL";
    break;
  case ERROR_DIRECTORY:
    code = "ENOTDIR";
    break;
  case ERROR_DIR_NOT_EMPTY:
    code = "ENOTEMPTY";
    break;
  case ERROR_CANT_ACCESS_FILE:
  case ERROR_REPARSE_POINT_ENCOUNTERED:
    code = "ELOOP";
    break;
  case ERROR_TOO_MANY_OPEN_FILES:
    code = "EMFILE";
    break;
  case ERROR_FILENAME_EXCED_RANGE:
    code = "ENAMETOOLONG";
    break;
  }
  snprintf(error->code, sizeof(error->code), "%s", code);
  snprintf(error->message, sizeof(error->message),
           "Generated-file cleanup failed (Windows error %lu)",
           (unsigned long)number);
  return -1;
}

/* Resolve the image containing our own data, without opening a pathname or
 * incrementing the module reference owned by the N-API loader. */


static WCHAR *wide_path(const char *path, cleanup_error *error) {
  int length =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (length == 0) {
    fail(error, GetLastError());
    return NULL;
  }
  WCHAR *wide = malloc((size_t)length * sizeof(WCHAR));
  if (wide == NULL) {
    fail(error, ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide,
                          length) == 0) {
    DWORD number = GetLastError();
    free(wide);
    fail(error, number);
    return NULL;
  }
  return wide;
}

/* Every name passed to NtCreateFile is exactly one component. No user pathname
 * is ever passed to a deletion function. OBJ_DONT_REPARSE also refuses any
 * reparsing attempted while resolving relative to an already held parent. */
static DWORD open_child(HANDLE parent, WCHAR *name, USHORT bytes, BOOL deleting,
                        BOOL exact_name, ULONG sharing, HANDLE *out) {
  UNICODE_STRING object_name = {bytes, bytes, name};
  OBJECT_ATTRIBUTES attributes;
  memset(&attributes, 0, sizeof(attributes));
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &object_name;
  attributes.Attributes = OBJ_DONT_REPARSE;
  if (!exact_name)
    attributes.Attributes |= OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK status_block;
  ACCESS_MASK access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY;
  if (deleting)
    access |= DELETE;
  NTSTATUS status = NtCreateFile(
      out, access, &attributes, &status_block, NULL, 0, sharing, FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
  return status < 0 ? RtlNtStatusToDosError(status) : ERROR_SUCCESS;
}

static int attributes_of(HANDLE handle, FILE_ATTRIBUTE_TAG_INFO *attributes,
                         cleanup_error *error) {
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, attributes,
                                    sizeof(*attributes))) {
    return fail(error, GetLastError());
  }
  return 0;
}



void cleanup_close_root(cleanup_root *root) {
  if (root == NULL)
    return;
  CloseHandle(root->handle);
  free(root);
}

int cleanup_clone_root(cleanup_root *root, cleanup_root **out,
                       cleanup_error *error) {
  *out = NULL;
  cleanup_root *copy = malloc(sizeof(*copy));
  if (copy == NULL)
    return fail(error, ERROR_NOT_ENOUGH_MEMORY);
  HANDLE process = GetCurrentProcess();
  if (!DuplicateHandle(process, root->handle, process, &copy->handle, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    DWORD number = GetLastError();
    free(copy);
    return fail(error, number);
  }
  *out = copy;
  return 0;
}

int cleanup_open_root(const char *path, cleanup_root **out,
                      cleanup_error *error) {
  *out = NULL;
  WCHAR *wide = wide_path(path, error);
  if (wide == NULL)
    return -1;
  size_t length = wcslen(wide);
  /* Persistent storage supplies a local DOS path. Ephemeral SDK sessions may
   * also use a canonical UNC share. Only the drive/share anchor is opened by
   * absolute name; every remaining component is acquired relative to a handle.
   */
  size_t drive_offset = 0;
  size_t server_begin = 0;
  if (length >= 4 && wcsncmp(wide, L"\\\\?\\", 4) == 0) {
    if (length >= 8 && _wcsnicmp(wide + 4, L"UNC\\", 4) == 0)
      server_begin = 8;
    else
      drive_offset = 4;
  } else if (length >= 2 && wide[0] == L'\\' && wide[1] == L'\\') {
    server_begin = 2;
  }
  size_t boundary;
  if (server_begin != 0) {
    size_t server_end = server_begin;
    while (server_end < length && wide[server_end] != L'\\')
      ++server_end;
    size_t share_begin = server_end + 1;
    boundary = share_begin;
    while (boundary < length && wide[boundary] != L'\\')
      ++boundary;
    if (server_end == server_begin || share_begin >= length ||
        boundary == share_begin ||
        (server_end - server_begin == 1 &&
         (wide[server_begin] == L'.' || wide[server_begin] == L'?'))) {
      free(wide);
      return fail(error, ERROR_INVALID_NAME);
    }
    for (size_t index = server_begin; index < boundary; ++index) {
      if (wide[index] == L':' || wide[index] == L'/') {
        free(wide);
        return fail(error, ERROR_INVALID_NAME);
      }
    }
  } else {
    if (length < drive_offset + 3 ||
        !((wide[drive_offset] >= L'A' && wide[drive_offset] <= L'Z') ||
          (wide[drive_offset] >= L'a' && wide[drive_offset] <= L'z')) ||
        wide[drive_offset + 1] != L':' || wide[drive_offset + 2] != L'\\') {
      free(wide);
      return fail(error, ERROR_INVALID_NAME);
    }
    boundary = drive_offset + 2;
  }
  WCHAR *anchor = malloc((boundary + 2) * sizeof(WCHAR));
  if (anchor == NULL) {
    free(wide);
    return fail(error, ERROR_NOT_ENOUGH_MEMORY);
  }
  memcpy(anchor, wide, boundary * sizeof(WCHAR));
  anchor[boundary] = L'\\';
  anchor[boundary + 1] = 0;
  cleanup_root *root = malloc(sizeof(*root));
  if (root == NULL) {
    free(anchor);
    free(wide);
    return fail(error, ERROR_NOT_ENOUGH_MEMORY);
  }
  HANDLE current = CreateFileW(
      anchor, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  DWORD open_error = GetLastError();
  free(anchor);
  if (current == INVALID_HANDLE_VALUE) {
    free(wide);
    free(root);
    return fail(error, open_error);
  }
  root->handle = current;
  for (size_t begin = boundary + 1; begin < length;) {
    size_t end = begin;
    while (end < length && wide[end] != L'\\')
      ++end;
    size_t count = end - begin;
    if (count == 0 || (count == 1 && wide[begin] == L'.') ||
        (count == 2 && wide[begin] == L'.' && wide[begin + 1] == L'.') ||
        count > USHRT_MAX / sizeof(WCHAR)) {
      fail(error, ERROR_INVALID_NAME);
      goto failed;
    }
    for (size_t index = begin; index < end; ++index) {
      if (wide[index] == L'/' || wide[index] == L':') {
        fail(error, ERROR_INVALID_NAME);
        goto failed;
      }
    }
    HANDLE child;
    DWORD number = open_child(
        current, wide + begin, (USHORT)(count * sizeof(WCHAR)), FALSE, FALSE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &child);
    if (number != ERROR_SUCCESS) {
      fail(error, number);
      goto failed;
    }
    CloseHandle(current);
    root->handle = child;
    FILE_ATTRIBUTE_TAG_INFO attributes;
    if (attributes_of(child, &attributes, error) != 0)
      goto failed;
    if (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      fail(error, ERROR_REPARSE_POINT_ENCOUNTERED);
      goto failed;
    }
    if (!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
      fail(error, ERROR_DIRECTORY);
      goto failed;
    }
    current = child;
    begin = end + 1;
  }
  free(wide);
  *out = root;
  return 0;
failed:
  free(wide);
  cleanup_close_root(root);
  return -1;
}

static DWORD close_frame(directory_frame *frame) {
  for (size_t index = 0; index < frame->count; ++index) {
    free(frame->names[index].value);
  }
  free(frame->names);
  return CloseHandle(frame->handle) ? ERROR_SUCCESS : GetLastError();
}

/* Snapshot names before deletion so removing an entry cannot move the native
 * enumeration cursor past a remaining entry. Opens later determine actual type.
 * Concurrent additions are caught by directory disposition, not retried here.
 */
static int read_names(directory_frame *frame, cleanup_error *error) {
  const DWORD capacity = 64 * 1024;
  BYTE *buffer = malloc(capacity);
  if (buffer == NULL)
    return fail(error, ERROR_NOT_ENOUGH_MEMORY);
  FILE_INFO_BY_HANDLE_CLASS kind = FileIdBothDirectoryRestartInfo;
  for (;;) {
    if (!GetFileInformationByHandleEx(frame->handle, kind, buffer, capacity)) {
      DWORD number = GetLastError();
      free(buffer);
      return number == ERROR_NO_MORE_FILES ? 0 : fail(error, number);
    }
    kind = FileIdBothDirectoryInfo;
    size_t offset = 0;
    for (;;) {
      size_t header = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
      if (offset > capacity - header)
        goto invalid;
      FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)(buffer + offset);
      DWORD bytes = entry->FileNameLength;
      if (bytes == 0 || bytes % sizeof(WCHAR) != 0 || bytes > USHRT_MAX ||
          bytes > capacity - offset - header)
        goto invalid;
      size_t count = bytes / sizeof(WCHAR);
      BOOL dot = (count == 1 && entry->FileName[0] == L'.') ||
                 (count == 2 && entry->FileName[0] == L'.' &&
                  entry->FileName[1] == L'.');
      if (!dot) {
        for (size_t index = 0; index < count; ++index) {
          WCHAR value = entry->FileName[index];
          if (value == 0 || value == L'\\' || value == L'/' || value == L':')
            goto invalid;
        }
        if (frame->count == SIZE_MAX / sizeof(child_name))
          goto memory;
        child_name *names =
            realloc(frame->names, (frame->count + 1) * sizeof(child_name));
        if (names == NULL)
          goto memory;
        frame->names = names;
        WCHAR *name = malloc(bytes);
        if (name == NULL)
          goto memory;
        memcpy(name, entry->FileName, bytes);
        frame->names[frame->count++] = (child_name){name, (USHORT)bytes};
      }
      if (entry->NextEntryOffset == 0)
        break;
      if (entry->NextEntryOffset < header + bytes ||
          entry->NextEntryOffset % sizeof(ULONGLONG) != 0 ||
          entry->NextEntryOffset > capacity - offset)
        goto invalid;
      offset += entry->NextEntryOffset;
    }
  }
invalid:
  free(buffer);
  return fail(error, ERROR_INVALID_DATA);
memory:
  free(buffer);
  return fail(error, ERROR_NOT_ENOUGH_MEMORY);
}

static int dispose(HANDLE handle, cleanup_error *error) {
  FILE_DISPOSITION_INFO disposition = {TRUE};
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &disposition,
                                  sizeof(disposition)))
    return fail(error, GetLastError());
  return 0;
}

/* An explicit stack keeps deeply nested generated trees off the C call stack.
 * Every ancestor stays open without delete sharing until its children finish.
 */
static int remove_tree(HANDLE initial, cleanup_error *error) {
  directory_frame *stack = calloc(1, sizeof(*stack));
  if (stack == NULL) {
    CloseHandle(initial);
    return fail(error, ERROR_NOT_ENOUGH_MEMORY);
  }
  size_t depth = 1;
  stack[0].handle = initial;
  for (;;) {
    directory_frame *frame = &stack[depth - 1];
    FILE_ATTRIBUTE_TAG_INFO attributes;
    if (attributes_of(frame->handle, &attributes, error) != 0)
      break;
    BOOL directory =
        (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
        !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
    if (directory && frame->names == NULL && frame->next == 0) {
      if (read_names(frame, error) != 0)
        break;
    }
    if (!directory || frame->next == frame->count) {
      if (dispose(frame->handle, error) != 0)
        break;
      DWORD number = close_frame(frame);
      --depth;
      if (number != ERROR_SUCCESS) {
        fail(error, number);
        break;
      }
      if (depth == 0) {
        free(stack);
        return 0;
      }
      continue;
    }
    child_name name = frame->names[frame->next++];
    HANDLE child;
    DWORD number = open_child(frame->handle, name.value, name.bytes, TRUE, TRUE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, &child);
    if (number == ERROR_FILE_NOT_FOUND || number == ERROR_PATH_NOT_FOUND)
      continue;
    if (number != ERROR_SUCCESS) {
      fail(error, number);
      break;
    }
    if (depth == SIZE_MAX / sizeof(*stack)) {
      CloseHandle(child);
      fail(error, ERROR_NOT_ENOUGH_MEMORY);
      break;
    }
    directory_frame *grown = realloc(stack, (depth + 1) * sizeof(*stack));
    if (grown == NULL) {
      CloseHandle(child);
      fail(error, ERROR_NOT_ENOUGH_MEMORY);
      break;
    }
    stack = grown;
    memset(&stack[depth], 0, sizeof(*stack));
    stack[depth++].handle = child;
  }
  while (depth != 0)
    close_frame(&stack[--depth]);
  free(stack);
  return -1;
}

static int remove_ids(HANDLE parent, const char *const *ids, size_t count,
                      cleanup_error *error) {
  for (size_t index = 0; index < count; ++index) {
    WCHAR *name = wide_path(ids[index], error);
    if (name == NULL)
      return -1;
    size_t length = wcslen(name);
    if (length == 0 || length > USHRT_MAX / sizeof(WCHAR) ||
        wcscmp(name, L".") == 0 || wcscmp(name, L"..") == 0 ||
        wcspbrk(name, L"\\/:") != NULL) {
      free(name);
      return fail(error, ERROR_INVALID_NAME);
    }
    HANDLE child;
    DWORD number =
        open_child(parent, name, (USHORT)(length * sizeof(WCHAR)), TRUE, FALSE,
                   FILE_SHARE_READ | FILE_SHARE_WRITE, &child);
    free(name);
    if (number == ERROR_FILE_NOT_FOUND || number == ERROR_PATH_NOT_FOUND)
      continue;
    if (number != ERROR_SUCCESS)
      return fail(error, number);
    if (remove_tree(child, error) != 0)
      return -1;
  }
  return 0;
}

int cleanup_remove_runs(cleanup_root *root, const char *directory,
                        const char *const *ids, size_t count,
                        cleanup_error *error) {
  WCHAR *name = wide_path(directory, error);
  if (name == NULL)
    return -1;
  size_t length = wcslen(name);
  if (length == 0 || length > USHRT_MAX / sizeof(WCHAR) ||
      wcscmp(name, L".") == 0 || wcscmp(name, L"..") == 0 ||
      wcspbrk(name, L"\\/:") != NULL) {
    free(name);
    return fail(error, ERROR_INVALID_NAME);
  }
  HANDLE generated;
  DWORD number =
      open_child(root->handle, name, (USHORT)(length * sizeof(WCHAR)), FALSE,
                 FALSE, FILE_SHARE_READ | FILE_SHARE_WRITE, &generated);
  free(name);
  if (number == ERROR_FILE_NOT_FOUND || number == ERROR_PATH_NOT_FOUND)
    return 0;
  if (number != ERROR_SUCCESS)
    return fail(error, number);
  FILE_ATTRIBUTE_TAG_INFO attributes;
  int result = attributes_of(generated, &attributes, error);
  if (result == 0 && (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    result = fail(error, ERROR_REPARSE_POINT_ENCOUNTERED);
  if (result == 0 && !(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY))
    result = fail(error, ERROR_DIRECTORY);
  if (result == 0)
    result = remove_ids(generated, ids, count, error);
  if (!CloseHandle(generated) && result == 0)
    return fail(error, GetLastError());
  return result;
}
