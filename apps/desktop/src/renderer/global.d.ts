import type { DesktopApi } from '../shared/ipc-contract.js';

declare global {
  interface Window {
    readonly desktopApp: DesktopApi;
  }
}

export {};
