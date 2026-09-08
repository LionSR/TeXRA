#ifndef TEXRA_CLEANUP_H
#define TEXRA_CLEANUP_H

#include <stddef.h>
#include <stdint.h>

typedef struct cleanup_root cleanup_root;

typedef struct {
  char code[32];
  char message[512];
} cleanup_error;

int cleanup_open_root(const char *path, cleanup_root **out,
                      cleanup_error *error);
int cleanup_clone_root(cleanup_root *root, cleanup_root **out,
                       cleanup_error *error);
int cleanup_remove_runs(cleanup_root *root, const char *directory,
                        const char *const *ids, size_t count,
                        cleanup_error *error);
void cleanup_close_root(cleanup_root *root);

#endif
