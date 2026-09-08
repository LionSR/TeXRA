#include "cleanup.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct cleanup_root {
  int fd;
};

static int fail(cleanup_error *error, int number) {
  const char *code;
  switch (number) {
  case EACCES:
    code = "EACCES";
    break;
  case EBADF:
    code = "EBADF";
    break;
  case EBUSY:
    code = "EBUSY";
    break;
  case EINVAL:
    code = "EINVAL";
    break;
  case EIO:
    code = "EIO";
    break;
  case ELOOP:
    code = "ELOOP";
    break;
  case EMFILE:
    code = "EMFILE";
    break;
  case ENAMETOOLONG:
    code = "ENAMETOOLONG";
    break;
  case ENFILE:
    code = "ENFILE";
    break;
  case ENOENT:
    code = "ENOENT";
    break;
  case ENOMEM:
    code = "ENOMEM";
    break;
  case ENOTDIR:
    code = "ENOTDIR";
    break;
  case ENOTEMPTY:
    code = "ENOTEMPTY";
    break;
  case EPERM:
    code = "EPERM";
    break;
  case EROFS:
    code = "EROFS";
    break;
  default:
    code = "EIO";
    break;
  }
  snprintf(error->code, sizeof(error->code), "%s", code);
  snprintf(error->message, sizeof(error->message),
           "Generated-file cleanup: %s (errno %d)", strerror(number), number);
  return -1;
}

/* Each component is acquired from a held directory, including the initial
 * storage path. Replacing any ancestor cannot redirect subsequent operations.
 */
int cleanup_open_root(const char *path, cleanup_root **out,
                      cleanup_error *error) {
  if (path[0] != '/')
    return fail(error, EINVAL);
  char *copy = strdup(path);
  if (copy == NULL)
    return fail(error, ENOMEM);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) {
    int number = errno;
    free(copy);
    return fail(error, number);
  }
  char *position = NULL;
  for (char *part = strtok_r(copy, "/", &position); part != NULL;
       part = strtok_r(NULL, "/", &position)) {
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) {
      close(fd);
      free(copy);
      return fail(error, EINVAL);
    }
    int next =
        openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int number = errno;
    close(fd);
    if (next < 0) {
      free(copy);
      return fail(error, number);
    }
    fd = next;
  }
  free(copy);
  cleanup_root *root = malloc(sizeof(*root));
  if (root == NULL) {
    close(fd);
    return fail(error, ENOMEM);
  }
  root->fd = fd;
  *out = root;
  return 0;
}

typedef struct {
  DIR *directory;
  char *name;
} directory_frame;

typedef struct {
  directory_frame *frames;
  size_t count;
  size_t capacity;
} traversal;

static void close_traversal(traversal *walk) {
  while (walk->count != 0) {
    directory_frame *frame = &walk->frames[--walk->count];
    closedir(frame->directory);
    free(frame->name);
  }
  free(walk->frames);
}

/* A link is unlinked in its owning directory. An opened directory remains the
 * traversal root even if its former pathname is replaced while we enumerate. */
static int enter_child(traversal *walk, int parent, const char *name,
                       cleanup_error *error) {
  int fd =
      openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    int number = errno;
    if (number == ENOENT)
      return 0;
    if (number != ENOTDIR && number != ELOOP)
      return fail(error, number);
    if (unlinkat(parent, name, 0) == 0 || errno == ENOENT)
      return 0;
    return fail(error, errno);
  }
  DIR *directory = fdopendir(fd);
  if (directory == NULL) {
    int number = errno;
    close(fd);
    return fail(error, number);
  }
  char *copy = strdup(name);
  if (copy == NULL) {
    closedir(directory);
    return fail(error, ENOMEM);
  }
  if (walk->count == walk->capacity) {
    size_t capacity = walk->capacity == 0 ? 8 : walk->capacity * 2;
    if (capacity < walk->capacity ||
        capacity > SIZE_MAX / sizeof(directory_frame)) {
      closedir(directory);
      free(copy);
      return fail(error, ENOMEM);
    }
    directory_frame *frames = realloc(walk->frames, capacity * sizeof(*frames));
    if (frames == NULL) {
      closedir(directory);
      free(copy);
      return fail(error, ENOMEM);
    }
    walk->frames = frames;
    walk->capacity = capacity;
  }
  walk->frames[walk->count++] = (directory_frame){directory, copy};
  return 0;
}

/* The explicit stack owns open directories without consuming the C call stack
 * for arbitrarily nested generated outputs. Resource exhaustion is retryable.
 */
static int remove_child(int parent, const char *name, cleanup_error *error) {
  traversal walk = {0};
  if (enter_child(&walk, parent, name, error) < 0)
    return -1;
  while (walk.count != 0) {
    directory_frame *frame = &walk.frames[walk.count - 1];
    errno = 0;
    struct dirent *entry = readdir(frame->directory);
    if (entry != NULL) {
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
        continue;
      if (enter_child(&walk, dirfd(frame->directory), entry->d_name, error) <
          0) {
        close_traversal(&walk);
        return -1;
      }
      continue;
    }
    int number = errno;
    if (number != 0) {
      close_traversal(&walk);
      return fail(error, number);
    }
    int owning_directory =
        walk.count == 1 ? parent : dirfd(walk.frames[walk.count - 2].directory);
    closedir(frame->directory);
    int result = unlinkat(owning_directory, frame->name, AT_REMOVEDIR);
    number = errno;
    free(frame->name);
    --walk.count;
    if (result != 0 && number != ENOENT) {
      close_traversal(&walk);
      return fail(error, number);
    }
  }
  free(walk.frames);
  return 0;
}

int cleanup_remove_runs(cleanup_root *root, const char *directory,
                        const char *const *ids, size_t count,
                        cleanup_error *error) {
  int runs = openat(root->fd, directory,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (runs < 0)
    return errno == ENOENT ? 0 : fail(error, errno);
  for (size_t index = 0; index < count; index++) {
    if (remove_child(runs, ids[index], error) < 0) {
      close(runs);
      return -1;
    }
  }
  close(runs);
  return 0;
}

void cleanup_close_root(cleanup_root *root) {
  close(root->fd);
  free(root);
}
