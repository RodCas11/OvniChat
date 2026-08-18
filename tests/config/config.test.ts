import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  envNonEmptyString,
  envPort,
  envPositiveInt,
  parseConfig,
} from '../../packages/config/src/index.js';

const exampleSchema = z
  .object({
    HOST: envNonEmptyString().default('127.0.0.1'),
    PORT: envPort().default(8090),
    TIMEOUT_MS: envPositiveInt().default(5000),
  })
  .strict();

describe('parseConfig', () => {
  it('applies defaults for entirely missing keys', () => {
    const config = parseConfig(exampleSchema, {});
    expect(config).toEqual({ HOST: '127.0.0.1', PORT: 8090, TIMEOUT_MS: 5000 });
  });

  it('coerces and validates provided string values', () => {
    const config = parseConfig(exampleSchema, {
      HOST: '0.0.0.0',
      PORT: '3000',
      TIMEOUT_MS: '1000',
    });
    expect(config).toEqual({ HOST: '0.0.0.0', PORT: 3000, TIMEOUT_MS: 1000 });
  });

  it('throws ConfigValidationError with every violation, not just the first', () => {
    let error: unknown;
    try {
      parseConfig(exampleSchema, { HOST: '', PORT: 'not-a-number', TIMEOUT_MS: '-5' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigValidationError);
    const configError = error as ConfigValidationError;
    expect(configError.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => parseConfig(exampleSchema, { PORT: '70000' })).toThrow(ConfigValidationError);
  });

  it('accepts port 0 (ephemeral bind)', () => {
    const config = parseConfig(exampleSchema, { PORT: '0' });
    expect(config.PORT).toBe(0);
  });

  it('rejects unknown keys the schema does not declare', () => {
    expect(() => parseConfig(exampleSchema, { HOST: 'x', UNKNOWN_KEY: 'y' })).toThrow(
      ConfigValidationError,
    );
  });
});
