# Desktop application boundary

This workspace will own Electron Main, Preload, Renderer, and desktop composition. T0 only
records toolchain configuration and non-executable marker modules. There is no window, UI, IPC
bridge, media capture, or packaging flow yet; those begin with T1.

Generic RTC and media behavior must live in the corresponding packages, not here. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
