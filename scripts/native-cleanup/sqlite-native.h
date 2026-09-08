#ifndef TEXRA_SQLITE_NATIVE_H
#define TEXRA_SQLITE_NATIVE_H

#include "cleanup.h"
#include <node_api.h>

napi_status cleanup_unwrap_root(napi_env env, napi_value value,
                                cleanup_root **root);
napi_status rooted_sqlite_exports(napi_env env, napi_value exports);

#endif
