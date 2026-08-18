# RTC core package boundary

This package will own the generic, UI-independent WebRTC transport abstraction. It may not depend
on Electron, React, Windows APIs, or `@disco-voador/windows-media`. P2P is the first transport, not
an assumption exposed to UI callers.
