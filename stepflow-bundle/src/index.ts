// stepflow — umbrella package. Re-exports the common trio so a single
// `npm install stepflow` (and one import surface) covers the engine, the durable
// repositories, and the parallel Puppeteer runtime.
//
// The browser (`puppeteer`) and a DB driver (`mysql2` or `better-sqlite3`) remain
// OPTIONAL peers — install only the ones your jobs use. Other packages
// (`@stepflow/integration`, `@stepflow/test`) stay separate; add them as needed.
export * from '@stepflow/core';
export * from '@stepflow/puppeteer';
export * from '@stepflow/infrastructure';
