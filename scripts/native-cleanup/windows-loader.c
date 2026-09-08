#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <delayimp.h>
#include <string.h>

/* N-API symbols belong to the running host, whose executable name differs
 * between the CLI, VS Code and Electron. Resolve the delayed node.exe import
 * against that process image instead of looking for another executable. */
static FARPROC WINAPI resolve_host(unsigned int notification,
                                   PDelayLoadInfo information) {
  if (notification == dliNotePreLoadLibrary &&
      _stricmp(information->szDll, "node.exe") == 0) {
    return (FARPROC)GetModuleHandleW(NULL);
  }
  return NULL;
}

/* MSVC declares a read-only hook; MinGW declares the pointer writable. */
#ifdef _MSC_VER
const PfnDliHook __pfnDliNotifyHook2 = resolve_host;
#else
PfnDliHook __pfnDliNotifyHook2 = resolve_host;
#endif
