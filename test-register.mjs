// Registers test-resolver.mjs so plain `node` can load this app's modules.
// Next.js resolves extensionless imports ("./users-store"); bare Node does
// not, so the .mjs tests below would fail to import anything real without
// this. Kept tiny and test-only -- it is not part of the app.
import { register } from 'node:module';
register('./test-resolver.mjs', import.meta.url);
