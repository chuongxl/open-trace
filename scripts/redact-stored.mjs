// One-off: redact secrets in rows stored before redaction existed. Usage: npm run redact-stored
import { redactStoredRows } from '../daemon/db/store.js';

console.log(`[redact-stored] redacted ${redactStoredRows()} rows`);
