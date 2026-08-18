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
