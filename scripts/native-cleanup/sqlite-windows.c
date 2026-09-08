#define WIN32_LEAN_AND_MEAN
#define SQLITE_CORE
#include "sqlite-vfs.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <winternl.h>

#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 1
#define FILE_CREATE 2
#define FILE_OPEN_IF 3
#endif
#define DB_PENDING 0x40000000UL
#define DB_RESERVED (DB_PENDING + 1)
#define DB_SHARED (DB_PENDING + 2)
#define DB_SHARED_SIZE 510
#define SHM_BASE 120
#define SHM_DMS (SHM_BASE + SQLITE_SHM_NLOCK)

typedef struct {
  void *base;
  void *region;
} mapped_region;

typedef struct {
  sqlite3_file base;
  rooted_sqlite_vfs_context *context;
  HANDLE handle;
  HANDLE shm;
  char *name;
  mapped_region *regions;
  int region_count;
  int region_size;
  int lock;
  unsigned shared_mask;
  unsigned exclusive_mask;
  DWORD last_error;
  int readonly;
} rooted_file;

/* Logical SQLite names are single components under the admitted capability.
 * Reparse points are refused on the actual opened handle, including objects
 * concurrently replaced before NtCreateFile resolves the relative name. */
static DWORD open_relative(rooted_sqlite_vfs_context *context, const char *name,
                           ACCESS_MASK access, ULONG disposition, HANDLE *out) {
  *out = INVALID_HANDLE_VALUE;
  if (!name || !*name || !strcmp(name, ".") || !strcmp(name, "..") ||
      strpbrk(name, "/\\:"))
    return ERROR_INVALID_NAME;
  int count =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, NULL, 0);
  if (count <= 0)
    return GetLastError();
  if ((unsigned)count > USHRT_MAX / (unsigned)sizeof(WCHAR))
    return ERROR_FILENAME_EXCED_RANGE;
  WCHAR *wide = malloc((size_t)count * sizeof(WCHAR));
  if (!wide)
    return ERROR_NOT_ENOUGH_MEMORY;
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, wide,
                           count)) {
    DWORD error = GetLastError();
    free(wide);
    return error;
  }
  USHORT bytes = (USHORT)((count - 1) * sizeof(WCHAR));
  UNICODE_STRING object_name = {bytes, bytes, wide};
  OBJECT_ATTRIBUTES attributes;
  memset(&attributes, 0, sizeof(attributes));
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = (HANDLE)cleanup_root_handle(context->root);
  attributes.ObjectName = &object_name;
  attributes.Attributes = OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK status_block;
  NTSTATUS status =
      NtCreateFile(out, access | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
                   &attributes, &status_block, NULL, FILE_ATTRIBUTE_NORMAL,
                   FILE_SHARE_READ | FILE_SHARE_WRITE, disposition,
                   FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT |
                       FILE_SYNCHRONOUS_IO_NONALERT,
                   NULL, 0);
  free(wide);
  if (status < 0)
    return RtlNtStatusToDosError(status);
  FILE_ATTRIBUTE_TAG_INFO info;
  DWORD error = ERROR_SUCCESS;
  if (!GetFileInformationByHandleEx(*out, FileAttributeTagInfo, &info,
                                    sizeof(info)))
    error = GetLastError();
  else if (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    error = ERROR_REPARSE_POINT_ENCOUNTERED;
  if (error) {
    CloseHandle(*out);
    *out = INVALID_HANDLE_VALUE;
  }
  return error;
}

static DWORD delete_relative(rooted_sqlite_vfs_context *context,
                             const char *name) {
  HANDLE handle;
  DWORD error = open_relative(context, name, DELETE, FILE_OPEN, &handle);
  if (error)
    return error;
  FILE_DISPOSITION_INFO deleting = {TRUE};
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &deleting,
                                  sizeof(deleting)))
    error = GetLastError();
  if (!CloseHandle(handle) && !error)
    error = GetLastError();
  return error;
}

static int io_error(rooted_file *file, int code) {
  file->last_error = GetLastError();
  return code;
}

static int change_lock(rooted_file *file, HANDLE handle, DWORD offset,
                       DWORD count, int exclusive, int unlock, int error_code) {
  OVERLAPPED position;
  memset(&position, 0, sizeof(position));
  position.Offset = offset;
  BOOL ok = unlock ? UnlockFileEx(handle, 0, count, 0, &position)
                   : LockFileEx(handle,
                                LOCKFILE_FAIL_IMMEDIATELY |
                                    (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0),
                                0, count, 0, &position);
  if (ok)
    return SQLITE_OK;
  DWORD error = GetLastError();
  file->last_error = error;
  if (!unlock && error == ERROR_LOCK_VIOLATION)
    return SQLITE_BUSY;
  return error_code;
}

static int set_size(HANDLE handle, sqlite3_int64 size) {
  FILE_END_OF_FILE_INFO end;
  end.EndOfFile.QuadPart = size;
  return SetFileInformationByHandle(handle, FileEndOfFileInfo, &end,
                                    sizeof(end));
}

static int rooted_read(sqlite3_file *base, void *buffer, int amount,
                       sqlite3_int64 offset) {
  rooted_file *file = (rooted_file *)base;
  OVERLAPPED position;
  memset(&position, 0, sizeof(position));
  position.Offset = (DWORD)offset;
  position.OffsetHigh = (DWORD)((sqlite3_uint64)offset >> 32);
  DWORD read = 0;
  if (!ReadFile(file->handle, buffer, (DWORD)amount, &read, &position)) {
    DWORD error = GetLastError();
    if (error != ERROR_HANDLE_EOF)
      return io_error(file, SQLITE_IOERR_READ);
  }
  if (read < (DWORD)amount) {
    memset((char *)buffer + read, 0, (size_t)amount - read);
    return SQLITE_IOERR_SHORT_READ;
  }
  return SQLITE_OK;
}

static int rooted_write(sqlite3_file *base, const void *buffer, int amount,
                        sqlite3_int64 offset) {
  rooted_file *file = (rooted_file *)base;
  OVERLAPPED position;
  memset(&position, 0, sizeof(position));
  position.Offset = (DWORD)offset;
  position.OffsetHigh = (DWORD)((sqlite3_uint64)offset >> 32);
  DWORD written = 0;
  if (!WriteFile(file->handle, buffer, (DWORD)amount, &written, &position)) {
    DWORD error = GetLastError();
    file->last_error = error;
    return error == ERROR_DISK_FULL || error == ERROR_HANDLE_DISK_FULL
               ? SQLITE_FULL
               : SQLITE_IOERR_WRITE;
  }
  return written == (DWORD)amount ? SQLITE_OK : SQLITE_FULL;
}

static int rooted_truncate(sqlite3_file *base, sqlite3_int64 size) {
  rooted_file *file = (rooted_file *)base;
  return set_size(file->handle, size) ? SQLITE_OK
                                      : io_error(file, SQLITE_IOERR_TRUNCATE);
}
static int rooted_sync(sqlite3_file *base, int flags) {
  rooted_file *file = (rooted_file *)base;
  (void)flags;
  return FlushFileBuffers(file->handle) ? SQLITE_OK
                                        : io_error(file, SQLITE_IOERR_FSYNC);
}
static int rooted_size(sqlite3_file *base, sqlite3_int64 *size) {
  rooted_file *file = (rooted_file *)base;
  LARGE_INTEGER value;
  if (!GetFileSizeEx(file->handle, &value))
    return io_error(file, SQLITE_IOERR_FSTAT);
  *size = value.QuadPart;
  return SQLITE_OK;
}

static int rooted_lock(sqlite3_file *base, int wanted) {
  rooted_file *file = (rooted_file *)base;
  if (file->lock >= wanted)
    return SQLITE_OK;
  if (file->readonly && wanted >= SQLITE_LOCK_RESERVED)
    return SQLITE_IOERR_LOCK;
  int result;
  if (file->lock == SQLITE_LOCK_NONE) {
    result =
        change_lock(file, file->handle, DB_PENDING, 1, 1, 0, SQLITE_IOERR_LOCK);
    if (result != SQLITE_OK)
      return result;
    result = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE, 0, 0,
                         SQLITE_IOERR_LOCK);
    int released = change_lock(file, file->handle, DB_PENDING, 1, 0, 1,
                               SQLITE_IOERR_UNLOCK);
    if (result == SQLITE_OK)
      file->lock = SQLITE_LOCK_SHARED;
    if (released != SQLITE_OK)
      return released;
    if (result != SQLITE_OK)
      return result;
  }
  if (wanted == SQLITE_LOCK_RESERVED) {
    result = change_lock(file, file->handle, DB_RESERVED, 1, 1, 0,
                         SQLITE_IOERR_LOCK);
    if (result == SQLITE_OK)
      file->lock = SQLITE_LOCK_RESERVED;
    return result;
  }
  if (wanted == SQLITE_LOCK_EXCLUSIVE) {
    if (file->lock < SQLITE_LOCK_PENDING) {
      result = change_lock(file, file->handle, DB_PENDING, 1, 1, 0,
                           SQLITE_IOERR_LOCK);
      if (result != SQLITE_OK)
        return result;
      file->lock = SQLITE_LOCK_PENDING;
    }
    result = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE, 0, 1,
                         SQLITE_IOERR_UNLOCK);
    if (result != SQLITE_OK)
      return result;
    result = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE, 1, 0,
                         SQLITE_IOERR_LOCK);
    if (result == SQLITE_OK)
      file->lock = SQLITE_LOCK_EXCLUSIVE;
    else {
      int restored = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE,
                                 0, 0, SQLITE_IOERR_LOCK);
      if (restored != SQLITE_OK)
        return restored;
    }
    return result;
  }
  return SQLITE_OK;
}

static int rooted_unlock(sqlite3_file *base, int wanted) {
  rooted_file *file = (rooted_file *)base;
  int result = SQLITE_OK;
  if (file->lock >= SQLITE_LOCK_EXCLUSIVE) {
    result = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE, 0, 1,
                         SQLITE_IOERR_UNLOCK);
    if (result != SQLITE_OK)
      return result;
    if (wanted == SQLITE_LOCK_SHARED) {
      result = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE, 0, 0,
                           SQLITE_IOERR_LOCK);
      if (result != SQLITE_OK)
        return result;
    }
  } else if (file->lock >= SQLITE_LOCK_SHARED && wanted == SQLITE_LOCK_NONE) {
    result = change_lock(file, file->handle, DB_SHARED, DB_SHARED_SIZE, 0, 1,
                         SQLITE_IOERR_UNLOCK);
    if (result != SQLITE_OK)
      return result;
  }
  /* RESERVED may not have been taken when SHARED upgraded directly. */
  if (file->lock >= SQLITE_LOCK_RESERVED) {
    OVERLAPPED position = {0};
    position.Offset = DB_RESERVED;
    if (!UnlockFileEx(file->handle, 0, 1, 0, &position) &&
        GetLastError() != ERROR_NOT_LOCKED)
      return io_error(file, SQLITE_IOERR_UNLOCK);
  }
  if (file->lock >= SQLITE_LOCK_PENDING) {
    result = change_lock(file, file->handle, DB_PENDING, 1, 0, 1,
                         SQLITE_IOERR_UNLOCK);
    if (result != SQLITE_OK)
      return result;
  }
  file->lock = wanted;
  return SQLITE_OK;
}

static int rooted_reserved(sqlite3_file *base, int *reserved) {
  rooted_file *file = (rooted_file *)base;
  *reserved = file->lock >= SQLITE_LOCK_RESERVED;
  if (*reserved)
    return SQLITE_OK;
  int result = change_lock(file, file->handle, DB_RESERVED, 1, 1, 0,
                           SQLITE_IOERR_CHECKRESERVEDLOCK);
  if (result == SQLITE_BUSY) {
    *reserved = 1;
    return SQLITE_OK;
  }
  if (result != SQLITE_OK)
    return result;
  return change_lock(file, file->handle, DB_RESERVED, 1, 0, 1,
                     SQLITE_IOERR_CHECKRESERVEDLOCK);
}

static int rooted_control(sqlite3_file *base, int operation, void *argument) {
  rooted_file *file = (rooted_file *)base;
  switch (operation) {
  case SQLITE_FCNTL_LOCKSTATE:
    *(int *)argument = file->lock;
    return SQLITE_OK;
  case SQLITE_FCNTL_LAST_ERRNO:
    *(int *)argument = (int)file->last_error;
    return SQLITE_OK;
  case SQLITE_FCNTL_HAS_MOVED:
    *(int *)argument = 0;
    return SQLITE_OK;
  default:
    return SQLITE_NOTFOUND;
  }
}
static int rooted_sector(sqlite3_file *file) {
  (void)file;
  return 4096;
}
static int rooted_characteristics(sqlite3_file *file) {
  (void)file;
  return 0;
}

static int open_shm(rooted_file *file) {
  if (file->shm != INVALID_HANDLE_VALUE)
    return SQLITE_OK;
  size_t length = strlen(file->name);
  char *name = malloc(length + 5);
  if (!name)
    return SQLITE_NOMEM;
  memcpy(name, file->name, length);
  memcpy(name + length, "-shm", 5);
  DWORD error = open_relative(file->context, name, GENERIC_READ | GENERIC_WRITE,
                              FILE_OPEN_IF, &file->shm);
  free(name);
  if (error) {
    file->last_error = error;
    return SQLITE_IOERR_SHMOPEN;
  }
  int result =
      change_lock(file, file->shm, SHM_DMS, 1, 1, 0, SQLITE_IOERR_SHMLOCK);
  if (result == SQLITE_OK) {
    if (!set_size(file->shm, 0))
      result = io_error(file, SQLITE_IOERR_SHMSIZE);
    int released =
        change_lock(file, file->shm, SHM_DMS, 1, 0, 1, SQLITE_IOERR_SHMLOCK);
    if (result == SQLITE_OK)
      result = released;
  } else if (result == SQLITE_BUSY)
    result = SQLITE_OK;
  if (result == SQLITE_OK)
    result =
        change_lock(file, file->shm, SHM_DMS, 1, 0, 0, SQLITE_IOERR_SHMLOCK);
  if (result != SQLITE_OK) {
    CloseHandle(file->shm);
    file->shm = INVALID_HANDLE_VALUE;
  }
  return result;
}

static int rooted_shm_map(sqlite3_file *base, int region, int size, int extend,
                          void volatile **out) {
  rooted_file *file = (rooted_file *)base;
  *out = NULL;
  int result = open_shm(file);
  if (result != SQLITE_OK)
    return result;
  if (region < 0 || size <= 0 ||
      (file->region_size && size != file->region_size))
    return SQLITE_IOERR_SHMSIZE;
  sqlite3_int64 end = ((sqlite3_int64)region + 1) * size;
  LARGE_INTEGER actual;
  if (!GetFileSizeEx(file->shm, &actual))
    return io_error(file, SQLITE_IOERR_SHMSIZE);
  if (actual.QuadPart < end) {
    if (!extend)
      return SQLITE_OK;
    if (!set_size(file->shm, end))
      return io_error(file, SQLITE_IOERR_SHMSIZE);
  }
  if (region >= file->region_count) {
    size_t count = (size_t)region + 1;
    if (count > SIZE_MAX / sizeof(mapped_region))
      return SQLITE_NOMEM;
    mapped_region *regions = realloc(file->regions, count * sizeof(*regions));
    if (!regions)
      return SQLITE_NOMEM;
    memset(regions + file->region_count, 0,
           (count - (size_t)file->region_count) * sizeof(*regions));
    file->regions = regions;
    file->region_count = region + 1;
    file->region_size = size;
  }
  if (!file->regions[region].base) {
    SYSTEM_INFO system;
    GetSystemInfo(&system);
    sqlite3_uint64 offset = (sqlite3_uint64)region * (unsigned)size;
    sqlite3_uint64 aligned = offset - offset % system.dwAllocationGranularity;
    SIZE_T delta = (SIZE_T)(offset - aligned);
    HANDLE mapping =
        CreateFileMappingW(file->shm, NULL, PAGE_READWRITE, 0, 0, NULL);
    if (!mapping)
      return io_error(file, SQLITE_IOERR_SHMMAP);
    void *view = MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE,
                               (DWORD)(aligned >> 32), (DWORD)aligned,
                               delta + (SIZE_T)size);
    DWORD error = GetLastError();
    if (!CloseHandle(mapping)) {
      DWORD close_error = GetLastError();
      if (view)
        UnmapViewOfFile(view);
      file->last_error = close_error;
      return SQLITE_IOERR_SHMMAP;
    }
    if (!view) {
      file->last_error = error;
      return SQLITE_IOERR_SHMMAP;
    }
    file->regions[region].base = view;
    file->regions[region].region = (char *)view + delta;
  }
  *out = file->regions[region].region;
  return SQLITE_OK;
}

static int rooted_shm_lock(sqlite3_file *base, int offset, int count,
                           int flags) {
  rooted_file *file = (rooted_file *)base;
  if (offset < 0 || count <= 0 || offset + count > SQLITE_SHM_NLOCK)
    return SQLITE_IOERR_SHMLOCK;
  int result = open_shm(file);
  if (result != SQLITE_OK)
    return result;
  unsigned mask = ((1u << count) - 1) << offset;
  int unlock = (flags & SQLITE_SHM_UNLOCK) != 0;
  int exclusive = (flags & SQLITE_SHM_EXCLUSIVE) != 0;
  unsigned *owned = exclusive ? &file->exclusive_mask : &file->shared_mask;
  if (!unlock && (*owned & mask) == mask)
    return SQLITE_OK;
  if (unlock && !(mask & (file->shared_mask | file->exclusive_mask)))
    return SQLITE_OK;
  result = change_lock(file, file->shm, SHM_BASE + (DWORD)offset, (DWORD)count,
                       exclusive, unlock, SQLITE_IOERR_SHMLOCK);
  if (result == SQLITE_OK) {
    if (unlock) {
      file->shared_mask &= ~mask;
      file->exclusive_mask &= ~mask;
    } else
      *owned |= mask;
  }
  return result;
}
static void rooted_shm_barrier(sqlite3_file *base) {
  (void)base;
  MemoryBarrier();
}

static int rooted_shm_unmap(sqlite3_file *base, int deleting) {
  rooted_file *file = (rooted_file *)base;
  int result = SQLITE_OK;
  int had_shm = file->shm != INVALID_HANDLE_VALUE;
  for (int index = 0; index < file->region_count; ++index)
    if (file->regions[index].base &&
        !UnmapViewOfFile(file->regions[index].base))
      result = io_error(file, SQLITE_IOERR_SHMMAP);
  free(file->regions);
  file->regions = NULL;
  file->region_count = 0;
  file->region_size = 0;
  if (file->shm != INVALID_HANDLE_VALUE) {
    if (!CloseHandle(file->shm))
      result = io_error(file, SQLITE_IOERR_SHMOPEN);
    file->shm = INVALID_HANDLE_VALUE;
  }
  file->shared_mask = file->exclusive_mask = 0;
  if (deleting && had_shm) {
    size_t length = strlen(file->name);
    char *name = malloc(length + 5);
    if (!name)
      return result == SQLITE_OK ? SQLITE_NOMEM : result;
    memcpy(name, file->name, length);
    memcpy(name + length, "-shm", 5);
    DWORD error = delete_relative(file->context, name);
    free(name);
    /* Other connections deny delete sharing while using this exact file.
     * As in SQLite's Windows VFS, their shared index survives this close. */
    if (error && error != ERROR_SHARING_VIOLATION &&
        error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND &&
        result == SQLITE_OK) {
      file->last_error = error;
      result = SQLITE_IOERR_DELETE;
    }
  }
  return result;
}
static int rooted_close(sqlite3_file *base) {
  rooted_file *file = (rooted_file *)base;
  int result = rooted_shm_unmap(base, 0);
  if (!CloseHandle(file->handle))
    result = io_error(file, SQLITE_IOERR_CLOSE);
  free(file->name);
  file->name = NULL;
  file->base.pMethods = NULL;
  return result;
}
static const sqlite3_io_methods methods = {2,
                                           rooted_close,
                                           rooted_read,
                                           rooted_write,
                                           rooted_truncate,
                                           rooted_sync,
                                           rooted_size,
                                           rooted_lock,
                                           rooted_unlock,
                                           rooted_reserved,
                                           rooted_control,
                                           rooted_sector,
                                           rooted_characteristics,
                                           rooted_shm_map,
                                           rooted_shm_lock,
                                           rooted_shm_barrier,
                                           rooted_shm_unmap,
                                           NULL,
                                           NULL};

static int rooted_open(sqlite3_vfs *vfs, const char *name, sqlite3_file *base,
                       int flags, int *actual_flags) {
  rooted_sqlite_vfs_context *context = vfs->pAppData;
  rooted_file *file = (rooted_file *)base;
  memset(file, 0, sizeof(*file));
  file->context = context;
  file->handle = file->shm = INVALID_HANDLE_VALUE;
  char temporary[80];
  if (!name) {
    unsigned char random[16];
    context->api->randomness(sizeof(random), random);
    char *cursor = temporary;
    cursor += sprintf(cursor, "texra-temp-");
    for (size_t index = 0; index < sizeof(random); ++index)
      cursor += sprintf(cursor, "%02x", random[index]);
    name = temporary;
    flags |=
        SQLITE_OPEN_CREATE | SQLITE_OPEN_EXCLUSIVE | SQLITE_OPEN_DELETEONCLOSE;
  }
  size_t length = strlen(name);
  file->name = malloc(length + 1);
  if (!file->name)
    return SQLITE_NOMEM;
  memcpy(file->name, name, length + 1);
  file->readonly = (flags & SQLITE_OPEN_READONLY) != 0;
  ACCESS_MASK access = GENERIC_READ;
  if (!file->readonly)
    access |= GENERIC_WRITE;
  if (flags & SQLITE_OPEN_DELETEONCLOSE)
    access |= DELETE;
  ULONG disposition = !(flags & SQLITE_OPEN_CREATE)     ? FILE_OPEN
                      : (flags & SQLITE_OPEN_EXCLUSIVE) ? FILE_CREATE
                                                        : FILE_OPEN_IF;
  DWORD error =
      open_relative(context, name, access, disposition, &file->handle);
  if (!error && (flags & SQLITE_OPEN_DELETEONCLOSE)) {
    FILE_DISPOSITION_INFO deleting = {TRUE};
    if (!SetFileInformationByHandle(file->handle, FileDispositionInfo,
                                    &deleting, sizeof(deleting)))
      error = GetLastError();
  }
  if (error) {
    file->last_error = error;
    if (file->handle != INVALID_HANDLE_VALUE)
      CloseHandle(file->handle);
    free(file->name);
    file->name = NULL;
    return SQLITE_CANTOPEN;
  }
  file->base.pMethods = &methods;
  if (actual_flags)
    *actual_flags = flags;
  return SQLITE_OK;
}

static int rooted_delete(sqlite3_vfs *vfs, const char *name,
                         int sync_directory) {
  rooted_sqlite_vfs_context *context = vfs->pAppData;
  (void)sync_directory;
  DWORD error = delete_relative(context, name);
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
    return SQLITE_OK;
  return error ? SQLITE_IOERR_DELETE : SQLITE_OK;
}
static int rooted_access(sqlite3_vfs *vfs, const char *name, int flags,
                         int *exists) {
  rooted_sqlite_vfs_context *context = vfs->pAppData;
  *exists = 0;
  if (!name)
    return SQLITE_OK;
  ACCESS_MASK access = FILE_READ_ATTRIBUTES;
  if (flags == SQLITE_ACCESS_READ || flags == SQLITE_ACCESS_READWRITE)
    access |= GENERIC_READ;
  if (flags == SQLITE_ACCESS_READWRITE)
    access |= GENERIC_WRITE;
  HANDLE handle;
  DWORD error = open_relative(context, name, access, FILE_OPEN, &handle);
  if (!error) {
    *exists = 1;
    if (flags == SQLITE_ACCESS_EXISTS) {
      LARGE_INTEGER size;
      if (!GetFileSizeEx(handle, &size)) {
        CloseHandle(handle);
        return SQLITE_IOERR_ACCESS;
      }
      /* SQLite's Windows VFS treats empty journal/WAL files as absent. */
      *exists = size.QuadPart != 0;
    }
    return CloseHandle(handle) ? SQLITE_OK : SQLITE_IOERR_ACCESS;
  }
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ||
      (error == ERROR_ACCESS_DENIED && flags != SQLITE_ACCESS_EXISTS))
    return SQLITE_OK;
  return SQLITE_IOERR_ACCESS;
}
void rooted_sqlite_platform_vfs(sqlite3_vfs *vfs,
                                rooted_sqlite_vfs_context *context) {
  (void)context;
  vfs->szOsFile = sizeof(rooted_file);
  vfs->xOpen = rooted_open;
  vfs->xDelete = rooted_delete;
  vfs->xAccess = rooted_access;
}

/* Admission describes the held directory, without reopening its pathname.
 * This preserves the previous DOS-versus-UNC local-storage policy. */
int rooted_sqlite_platform_admit(cleanup_root *root, cleanup_error *error) {
  HANDLE handle = (HANDLE)cleanup_root_handle(root);
  DWORD capacity = GetFinalPathNameByHandleW(
      handle, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  DWORD number = ERROR_SUCCESS;
  WCHAR *path = NULL;
  if (!capacity)
    number = GetLastError();
  else if (!(path = malloc((size_t)capacity * sizeof(WCHAR))))
    number = ERROR_NOT_ENOUGH_MEMORY;
  if (!number) {
    DWORD length = GetFinalPathNameByHandleW(
        handle, path, capacity, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!length)
      number = GetLastError();
    else if (length >= capacity)
      number = ERROR_INSUFFICIENT_BUFFER;
    else {
      size_t offset = length >= 4 && wcsncmp(path, L"\\\\?\\", 4) == 0 ? 4 : 0;
      WCHAR drive = path[offset];
      if (length < offset + 3 ||
          !((drive >= L'A' && drive <= L'Z') ||
            (drive >= L'a' && drive <= L'z')) ||
          path[offset + 1] != L':' || path[offset + 2] != L'\\')
        number = ERROR_NOT_SUPPORTED;
    }
  }
  free(path);
  if (!number)
    return 0;
  snprintf(error->code, sizeof(error->code), "%s",
           number == ERROR_NOT_SUPPORTED ? "ENOTSUP" : "EIO");
  snprintf(error->message, sizeof(error->message),
           "Session storage must be on a verified local filesystem (Windows "
           "error %lu)",
           (unsigned long)number);
  return -1;
}
