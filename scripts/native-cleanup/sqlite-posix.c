#include "sqlite-vfs.h"

#include <sys/stat.h>
#ifdef __APPLE__
#include <sys/mount.h>
#else
#include <sys/vfs.h>
#endif
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/* OFD locks retain SQLite's public byte-lock protocol without process-wide
 * close(fd) lock loss between this driver's own connections. Stock SQLite
 * interoperates across processes; do not mix stock and rooted VFS connections
 * to the same database inside one process. */
static int root_fd(const rooted_sqlite_vfs_context *context) {
  return (int)cleanup_root_handle(context->root);
}

typedef struct {
  void *base;
  size_t size;
  void *page;
} Region;
typedef struct {
  sqlite3_file base;
  rooted_sqlite_vfs_context *context;
  int fd;
  int level;
  int shm;
  Region *regions;
  int count;
  char name[256];
} File;

#define PENDING ((off_t)0x40000000)
#define RESERVED (PENDING + 1)
#define SHARED (PENDING + 2)
#define SHMSLOT 120
#define DEADMAN 128
static int single(const char *s) {
  return s && *s && !strchr(s, '/') && !strchr(s, '\\') && strcmp(s, ".") &&
         strcmp(s, "..");
}
static int lockRange(int fd, int type, off_t start, off_t length) {
  struct flock f = {
      .l_type = type, .l_whence = SEEK_SET, .l_start = start, .l_len = length};
  if (fcntl(fd, F_OFD_SETLK, &f) == 0)
    return SQLITE_OK;
  return errno == EAGAIN || errno == EACCES ? SQLITE_BUSY : SQLITE_IOERR_LOCK;
}
static int queryRange(int fd, off_t start, int *type) {
  struct flock f = {
      .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = start, .l_len = 1};
  if (fcntl(fd, F_OFD_GETLK, &f) < 0)
    return SQLITE_IOERR_LOCK;
  *type = f.l_type;
  return SQLITE_OK;
}
static int shmUnmap(sqlite3_file *base, int remove) {
  File *f = (File *)base;
  if (f->shm < 0)
    return SQLITE_OK;
  int result = SQLITE_OK;
  for (int i = 0; i < f->count; i++) {
    if (f->regions[i].base &&
        munmap(f->regions[i].base, f->regions[i].size) < 0 &&
        result == SQLITE_OK)
      result = SQLITE_IOERR_SHMMAP;
  }
  free(f->regions);
  f->regions = NULL;
  f->count = 0;
  if (remove) {
    int locked = lockRange(f->shm, F_WRLCK, DEADMAN, 1);
    if (locked == SQLITE_OK) {
      char name[sizeof(f->name) + 4];
      snprintf(name, sizeof(name), "%s-shm", f->name);
      if (unlinkat(root_fd(f->context), name, 0) < 0 && errno != ENOENT &&
          result == SQLITE_OK)
        result = SQLITE_IOERR_DELETE;
    } else if (locked != SQLITE_BUSY && result == SQLITE_OK)
      result = locked;
  }
  if (close(f->shm) < 0 && result == SQLITE_OK)
    result = SQLITE_IOERR_CLOSE;
  f->shm = -1;
  return result;
}
static int fileClose(sqlite3_file *base) {
  File *f = (File *)base;
  int result = shmUnmap(base, 0);
  if (close(f->fd) < 0 && result == SQLITE_OK)
    result = SQLITE_IOERR_CLOSE;
  return result;
}
static int fileRead(sqlite3_file *base, void *data, int amount,
                    sqlite3_int64 offset) {
  File *f = (File *)base;
  int done = 0;
  while (done < amount) {
    ssize_t n = pread(f->fd, (char *)data + done, (size_t)(amount - done),
                      (off_t)offset + done);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      return SQLITE_IOERR_READ;
    }
    if (n == 0) {
      memset((char *)data + done, 0, (size_t)(amount - done));
      return SQLITE_IOERR_SHORT_READ;
    }
    done += (int)n;
  }
  return SQLITE_OK;
}
static int fileWrite(sqlite3_file *base, const void *data, int amount,
                     sqlite3_int64 offset) {
  File *f = (File *)base;
  int done = 0;
  while (done < amount) {
    ssize_t n = pwrite(f->fd, (const char *)data + done,
                       (size_t)(amount - done), (off_t)offset + done);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      return errno == ENOSPC ? SQLITE_FULL : SQLITE_IOERR_WRITE;
    }
    if (n == 0)
      return SQLITE_IOERR_WRITE;
    done += (int)n;
  }
  return SQLITE_OK;
}
static int fileTruncate(sqlite3_file *base, sqlite3_int64 size) {
  return ftruncate(((File *)base)->fd, (off_t)size) == 0
             ? SQLITE_OK
             : SQLITE_IOERR_TRUNCATE;
}
static int fileSync(sqlite3_file *base, int flags) {
  (void)flags;
  File *f = (File *)base;
  if (fsync(f->fd) < 0)
    return SQLITE_IOERR_FSYNC;
  return fsync(root_fd(f->context)) == 0 ? SQLITE_OK : SQLITE_IOERR_DIR_FSYNC;
}
static int fileSize(sqlite3_file *base, sqlite3_int64 *size) {
  struct stat st;
  if (fstat(((File *)base)->fd, &st) < 0)
    return SQLITE_IOERR_FSTAT;
  *size = st.st_size;
  return SQLITE_OK;
}
static int fileLock(sqlite3_file *base, int level) {
  File *f = (File *)base;
  int rc;
  if (level <= f->level)
    return SQLITE_OK;
  if (f->level == SQLITE_LOCK_NONE) {
    rc = lockRange(f->fd, F_RDLCK, PENDING, 1);
    if (rc)
      return rc;
    rc = lockRange(f->fd, F_RDLCK, SHARED, 510);
    int released = lockRange(f->fd, F_UNLCK, PENDING, 1);
    if (rc)
      return rc;
    f->level = SQLITE_LOCK_SHARED;
    if (released)
      return released;
  }
  if (level == SQLITE_LOCK_RESERVED) {
    rc = lockRange(f->fd, F_WRLCK, RESERVED, 1);
    if (rc)
      return rc;
    f->level = level;
    return SQLITE_OK;
  }
  if (level >= SQLITE_LOCK_PENDING) {
    rc = lockRange(f->fd, F_WRLCK, PENDING, 1);
    if (rc)
      return rc;
    f->level = SQLITE_LOCK_PENDING;
  }
  if (level == SQLITE_LOCK_EXCLUSIVE) {
    rc = lockRange(f->fd, F_WRLCK, SHARED, 510);
    if (rc)
      return rc;
    f->level = level;
  }
  return SQLITE_OK;
}
static int fileUnlock(sqlite3_file *base, int level) {
  File *f = (File *)base;
  int rc;
  if (level == SQLITE_LOCK_SHARED) {
    rc = lockRange(f->fd, F_RDLCK, SHARED, 510);
    if (rc)
      return rc;
    rc = lockRange(f->fd, F_UNLCK, PENDING, 2);
  } else
    rc = lockRange(f->fd, F_UNLCK, PENDING, 512);
  if (rc == SQLITE_OK)
    f->level = level;
  return rc;
}
static int reserved(sqlite3_file *base, int *out) {
  File *f = (File *)base;
  if (f->level >= SQLITE_LOCK_RESERVED) {
    *out = 1;
    return SQLITE_OK;
  }
  int type;
  int rc = queryRange(f->fd, RESERVED, &type);
  if (rc == SQLITE_OK)
    *out = type != F_UNLCK;
  return rc;
}
static int control(sqlite3_file *base, int op, void *value) {
  File *f = (File *)base;
  if (op == SQLITE_FCNTL_LOCKSTATE) {
    *(int *)value = f->level;
    return SQLITE_OK;
  }
  if (op == SQLITE_FCNTL_HAS_MOVED) {
    struct stat held, named;
    if (fstat(f->fd, &held) < 0)
      return SQLITE_IOERR_FSTAT;
    *(int *)value = fstatat(root_fd(f->context), f->name, &named,
                            AT_SYMLINK_NOFOLLOW) < 0 ||
                    held.st_dev != named.st_dev || held.st_ino != named.st_ino;
    return SQLITE_OK;
  }
  return SQLITE_NOTFOUND;
}
static int sector(sqlite3_file *f) {
  (void)f;
  return 4096;
}
static int characteristics(sqlite3_file *f) {
  (void)f;
  return 0;
}
static int shmMap(sqlite3_file *base, int page, int size, int extend,
                  void volatile **out) {
  File *f = (File *)base;
  *out = NULL;
  if (f->shm < 0) {
    char name[sizeof(f->name) + 4];
    snprintf(name, sizeof(name), "%s-shm", f->name);
    int fd = openat(root_fd(f->context), name,
                    O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0)
      return SQLITE_IOERR_SHMOPEN;
    int type, rc = queryRange(fd, DEADMAN, &type);
    if (rc == SQLITE_OK && type == F_WRLCK)
      rc = SQLITE_BUSY;
    if (rc == SQLITE_OK && type == F_UNLCK) {
      rc = lockRange(fd, F_WRLCK, DEADMAN, 1);
      if (rc == SQLITE_OK && ftruncate(fd, 3) < 0)
        rc = SQLITE_IOERR_SHMSIZE;
    }
    if (rc == SQLITE_OK)
      rc = lockRange(fd, F_RDLCK, DEADMAN, 1);
    if (rc != SQLITE_OK) {
      close(fd);
      return rc;
    }
    f->shm = fd;
  }
  if (page >= f->count) {
    Region *p = realloc(f->regions, (size_t)(page + 1) * sizeof(*p));
    if (!p)
      return SQLITE_NOMEM;
    memset(p + f->count, 0, (size_t)(page + 1 - f->count) * sizeof(*p));
    f->regions = p;
    f->count = page + 1;
  }
  if (!f->regions[page].base) {
    struct stat st;
    if (fstat(f->shm, &st) < 0)
      return SQLITE_IOERR_SHMSIZE;
    off_t end = (off_t)(page + 1) * size;
    if (st.st_size < end) {
      if (!extend)
        return SQLITE_OK;
      if (ftruncate(f->shm, end) < 0)
        return SQLITE_IOERR_SHMSIZE;
    }
    long unit = sysconf(_SC_PAGESIZE);
    off_t offset = (off_t)page * size;
    off_t aligned = offset - (offset % unit);
    size_t bytes = (size_t)(offset - aligned) + size;
    void *p =
        mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, f->shm, aligned);
    if (p == MAP_FAILED)
      return SQLITE_IOERR_SHMMAP;
    f->regions[page] = (Region){p, bytes, (char *)p + (offset - aligned)};
  }
  *out = f->regions[page].page;
  return SQLITE_OK;
}
static int shmLock(sqlite3_file *base, int offset, int count, int flags) {
  File *f = (File *)base;
  int type = (flags & SQLITE_SHM_UNLOCK)
                 ? F_UNLCK
                 : ((flags & SQLITE_SHM_EXCLUSIVE) ? F_WRLCK : F_RDLCK);
  return lockRange(f->shm, type, SHMSLOT + offset, count);
}
static void shmBarrier(sqlite3_file *base) {
  (void)base;
  atomic_thread_fence(memory_order_seq_cst);
}
static const sqlite3_io_methods methods = {.iVersion = 2,
                                           .xClose = fileClose,
                                           .xRead = fileRead,
                                           .xWrite = fileWrite,
                                           .xTruncate = fileTruncate,
                                           .xSync = fileSync,
                                           .xFileSize = fileSize,
                                           .xLock = fileLock,
                                           .xUnlock = fileUnlock,
                                           .xCheckReservedLock = reserved,
                                           .xFileControl = control,
                                           .xSectorSize = sector,
                                           .xDeviceCharacteristics =
                                               characteristics,
                                           .xShmMap = shmMap,
                                           .xShmLock = shmLock,
                                           .xShmBarrier = shmBarrier,
                                           .xShmUnmap = shmUnmap};
static int vfsOpen(sqlite3_vfs *v, const char *name, sqlite3_file *base,
                   int flags, int *out) {
  File *f = (File *)base;
  memset(f, 0, sizeof(*f));
  f->fd = -1;
  f->shm = -1;
  f->context = v->pAppData;
  char temporary[64];
  if (name == NULL) {
    unsigned char random[16];
    f->context->api->randomness(sizeof(random), random);
    memcpy(temporary, ".texra-sqlite-", 14);
    for (size_t i = 0; i < sizeof(random); i++)
      snprintf(temporary + 14 + i * 2, 3, "%02x", random[i]);
    name = temporary;
    flags |=
        SQLITE_OPEN_CREATE | SQLITE_OPEN_EXCLUSIVE | SQLITE_OPEN_DELETEONCLOSE;
  }
  if (!single(name) || strlen(name) >= sizeof(f->name))
    return SQLITE_CANTOPEN;
  int openFlags = (flags & SQLITE_OPEN_READONLY) ? O_RDONLY : O_RDWR;
  if (flags & SQLITE_OPEN_CREATE)
    openFlags |= O_CREAT;
  if (flags & SQLITE_OPEN_EXCLUSIVE)
    openFlags |= O_EXCL;
  f->fd = openat(root_fd(f->context), name, openFlags | O_NOFOLLOW | O_CLOEXEC,
                 0600);
  if (f->fd < 0)
    return SQLITE_CANTOPEN;
  memcpy(f->name, name, strlen(name) + 1);
  if ((flags & SQLITE_OPEN_DELETEONCLOSE) &&
      unlinkat(root_fd(f->context), name, 0) < 0) {
    close(f->fd);
    return SQLITE_IOERR_DELETE;
  }
  f->base.pMethods = &methods;
  if (out)
    *out = flags;
  return SQLITE_OK;
}
static int vfsDelete(sqlite3_vfs *v, const char *name, int sync) {
  rooted_sqlite_vfs_context *r = v->pAppData;
  if (!single(name))
    return SQLITE_IOERR_DELETE;
  if (unlinkat(root_fd(r), name, 0) < 0 && errno != ENOENT)
    return SQLITE_IOERR_DELETE;
  return !sync || fsync(root_fd(r)) == 0 ? SQLITE_OK : SQLITE_IOERR_DIR_FSYNC;
}
static int vfsAccess(sqlite3_vfs *v, const char *name, int flags, int *out) {
  rooted_sqlite_vfs_context *r = v->pAppData;
  *out = 0;
  if (!single(name))
    return SQLITE_IOERR_ACCESS;
  if (flags == SQLITE_ACCESS_EXISTS) {
    struct stat st;
    if (fstatat(root_fd(r), name, &st, AT_SYMLINK_NOFOLLOW) < 0)
      return errno == ENOENT ? SQLITE_OK : SQLITE_IOERR_ACCESS;
    if (S_ISLNK(st.st_mode))
      return SQLITE_CANTOPEN;
    *out = st.st_size > 0;
    return SQLITE_OK;
  }
  int mode = flags == SQLITE_ACCESS_READWRITE ? O_RDWR : O_RDONLY;
  int fd = openat(root_fd(r), name, mode | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) {
    if (errno == ENOENT || errno == EACCES || errno == EROFS)
      return SQLITE_OK;
    return SQLITE_IOERR_ACCESS;
  }
  struct stat st;
  int result = fstat(fd, &st) == 0 ? SQLITE_OK : SQLITE_IOERR_ACCESS;
  if (result == SQLITE_OK) {
    if (S_ISREG(st.st_mode))
      *out = 1;
    else
      result = SQLITE_CANTOPEN;
  }
  if (close(fd) < 0 && result == SQLITE_OK)
    result = SQLITE_IOERR_ACCESS;
  return result;
}

void rooted_sqlite_platform_vfs(sqlite3_vfs *vfs,
                                rooted_sqlite_vfs_context *context) {
  vfs->pAppData = context;
  vfs->szOsFile = sizeof(File);
  vfs->xOpen = vfsOpen;
  vfs->xDelete = vfsDelete;
  vfs->xAccess = vfsAccess;
}

/* C1 classification belongs to the admitted directory, not its former name. */
int rooted_sqlite_platform_admit(cleanup_root *root, cleanup_error *error) {
  struct statfs info;
  if (fstatfs((int)cleanup_root_handle(root), &info) < 0) {
    snprintf(error->code, sizeof(error->code), "%s", "EIO");
    snprintf(error->message, sizeof(error->message), "%s", strerror(errno));
    return -1;
  }
#ifdef __APPLE__
  int local = (info.f_flags & MNT_LOCAL) != 0;
#else
  /* Exactly the preceding C1 Linux allowlist, now queried through the fd. */
  const uint32_t local_types[] = {
      0xef53,     0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1,
      0xf2f52010, 0x3153464a, 0x52654973, 0x3434,     0x42465331, 0x28cd3d45,
      0x73717368, 0x4d44,     0x2011bab0, 0x5346544e};
  int local = 0;
  for (size_t i = 0; i < sizeof(local_types) / sizeof(local_types[0]); i++) {
    if ((uint32_t)info.f_type == local_types[i])
      local = 1;
  }
#endif
  if (local)
    return 0;
  snprintf(error->code, sizeof(error->code), "%s", "ENOTSUP");
  snprintf(error->message, sizeof(error->message), "%s",
           "Session storage must be on a verified local filesystem.");
  return -1;
}
