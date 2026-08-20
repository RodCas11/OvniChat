// T12 - shared Windows target-version configuration.
//
// Must be the very first thing any translation unit in this helper includes (before <windows.h> or
// any SDK header) so every header sees a consistent target: Windows 10 "Fe" (20348-class) or newer,
// which is the minimum required for process-loopback activation
// (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK) per docs/references/WINDOWS_MEDIA.md. The real
// runtime gate is packages/windows-media/src/capability.ts on the TypeScript side (never trust a
// product-name string); this only controls which struct/enum declarations the compiler sees.
#pragma once

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef NTDDI_VERSION
#define NTDDI_VERSION 0x0A00000B // NTDDI_WIN10_CO - comfortably above the 20348 process-loopback floor.
#endif

// Trim rarely-needed Windows.h surface (no GDI, no sockets clash, etc.) to keep build times and
// symbol collisions down; nothing this helper needs lives in the trimmed-out pieces.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
