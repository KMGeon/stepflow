// Subpath entry: `import { MySqlJobRepository } from 'stepflow/mysql'`.
// Kept separate from the root barrel so consumers who only use the in-memory
// repository never pull mysql2 types into their build (mysql2 is an optional peer).
export { MySqlJobRepository } from './repository/mysql';
