import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Minimal D1 binding over node:sqlite with the real migrations applied. */
export function createD1(migrations = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
  const db = new DatabaseSync(':memory:');
  for (const name of migrations) db.exec(readFileSync(join(migrationsDir, name), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    runSync: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    sqlite: db,
    prepare: sql => statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(item => item.runSync());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
