import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg) {
  process.stderr.write('Usage: sqlite_backup_verify.mjs <source-db> [destination-db|--verify-only]\n');
  process.exit(2);
}
const source = path.resolve(sourceArg);
let db;
try {
  db = new DatabaseSync(source, { readOnly: true });
  if (destinationArg === '--verify-only') {
    const quick = db.prepare('PRAGMA quick_check').all();
    if (quick.length !== 1 || quick[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed.');
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    process.stdout.write(JSON.stringify({ status: 'PASS', integrity: 'ok', tableCount: tables }));
  } else {
    if (!destinationArg) throw new Error('Destination is required.');
    const destination = path.resolve(destinationArg);
    if (source.toLowerCase() === destination.toLowerCase()) throw new Error('Source and destination must differ.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { force: true });
    await backup(db, destination);
    const verify = new DatabaseSync(destination, { readOnly: true });
    try {
      const quick = verify.prepare('PRAGMA quick_check').all();
      if (quick.length !== 1 || quick[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed.');
      const tableCount = verify.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
      const stat = await fs.stat(destination);
      process.stdout.write(JSON.stringify({ status: 'PASS', sizeBytes: stat.size, tableCount, integrity: 'ok' }));
    } finally { verify.close(); }
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ status: 'FAIL', code: String(error?.code || 'SQLITE_BACKUP_FAILED').replace(/[^A-Z0-9_]/g, '').slice(0, 64) }));
  process.exitCode = 1;
} finally { db?.close(); }

