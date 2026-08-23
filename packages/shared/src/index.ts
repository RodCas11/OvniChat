/** T13.3 — first real consumers: `services/dedicated-server` (authoritative validation before
 * persisting an uploaded avatar) and `apps/desktop`'s Main process (validating a locally-picked
 * file, and re-validating avatar bytes received from a remote Dedicated Server) both need
 * byte-identical image-sniffing behavior — see `image-validation.ts`'s own doc comment. */
export {
  validateAvatarImage,
  type ImageValidationFailureCode,
  type ImageValidationResult,
} from './image-validation.js';
