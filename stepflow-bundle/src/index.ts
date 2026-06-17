// @kmgeon/stepflow — umbrella package. Re-exports the common trio so a single
// `npm install @kmgeon/stepflow` (and one import surface) covers the engine, the
// durable repositories, and the parallel Puppeteer runtime.
//
// The browser (`puppeteer`) and a DB driver (`mysql2` or `better-sqlite3`) remain
// OPTIONAL peers — install only the ones your jobs use. Other packages
// (`@kmgeon/stepflow-integration`, `@kmgeon/stepflow-test`) stay separate; add them as needed.
export * from '@kmgeon/stepflow-core';
export * from '@kmgeon/stepflow-puppeteer';
export * from '@kmgeon/stepflow-infrastructure';
