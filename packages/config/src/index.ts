import { z } from 'zod';

/**
 * Thrown by {@link parseConfig} when a configuration source fails validation. Lists every
 * violation (not just the first), so a misconfigured deployment fails once with a complete,
 * actionable message instead of a slow trickle of individually-discovered problems.
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Parses and validates a source of environment-style string values (typically `process.env`)
 * against a zod schema, producing a typed, immutable result. This is the single place raw
 * environment access should happen — domain code receives only the already-validated, typed
 * result, never `process.env` directly.
 */
export function parseConfig<Schema extends z.ZodType>(
  schema: Schema,
  source: Record<string, string | undefined>,
): z.infer<Schema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }
  return result.data;
}

/**
 * Environment variables always arrive as strings (or are absent). These small factories give a
 * consistent, reusable way to coerce+bound the common numeric shapes a service's configuration
 * needs, so each consumer doesn't hand-roll its own `z.coerce.number()...` chain.
 */

/** A TCP port: an integer in `[0, 65535]`. `0` is a valid value meaning "bind an ephemeral port". */
export function envPort() {
  return z.coerce.number().int().min(0).max(65535);
}

export function envPositiveInt() {
  return z.coerce.number().int().positive();
}

export function envNonEmptyString() {
  return z.string().min(1);
}
