# Configuration package boundary

Small, reusable `zod`-based helpers for parsing and validating typed configuration from
environment-style string sources: `parseConfig(schema, source)` validates a source once and
throws a `ConfigValidationError` listing every violation, plus a few common numeric coercion
schema factories (`envPort`, `envPositiveInt`, `envNonEmptyString`).

This package defines no concrete configuration shape itself — each service/app owns its own
schema (e.g. `services/realtime/src/config.ts`) built from these primitives. It must not embed
credentials, silently supply production defaults for secrets, or read `process.env` on its own;
callers pass the source explicitly.
