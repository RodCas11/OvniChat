export {
  MicrophoneAccessError,
  classifyMicrophoneErrorReason,
  type MicrophoneErrorReason,
} from './microphone-errors.js';
export { acquireMicrophone, type Microphone, type MicrophoneConstraints } from './microphone.js';
export {
  CameraAccessError,
  classifyCameraErrorReason,
  type CameraErrorReason,
} from './camera-errors.js';
export { acquireCamera, type Camera, type CameraConstraints } from './camera.js';
export {
  ScreenAccessError,
  classifyScreenErrorReason,
  type ScreenErrorReason,
} from './screen-errors.js';
export {
  acquireScreen,
  SCREEN_QUALITY_PRESETS,
  type Screen,
  type ScreenConstraints,
  type ScreenQualityPreset,
} from './screen.js';
