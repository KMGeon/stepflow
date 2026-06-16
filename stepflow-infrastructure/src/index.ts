// @stepflow/infrastructure — JobRepository adapters backed by external systems.
// Kept out of @stepflow/core so consumers who only use the in-memory repository
// never pull mysql2 into their build (mysql2 is a peer dependency here).
export { MySqlJobRepository } from './mysql';
