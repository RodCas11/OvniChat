import { verifyArchitecture } from './verify-architecture.mjs';
import { verifyDependencies } from './verify-dependencies.mjs';
import { verifyHarness } from './verify-harness.mjs';
import { verifyInfrastructure } from './verify-infrastructure.mjs';
import { verifyLinks } from './verify-links.mjs';
import { verifySecrets } from './verify-secrets.mjs';
import { verifyVersion } from './verify-version.mjs';

await verifyArchitecture();
await verifyDependencies();
await verifyHarness();
await verifyInfrastructure();
await verifyLinks();
await verifySecrets();
await verifyVersion();

console.info('Repository verification passed.');
