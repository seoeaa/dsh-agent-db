import { defineTool } from '@deepseek-ai/dsh-tools';
import { DbError } from './manager.js';

export const name = 'agent-db-tools';
export const inject = ['tools', 'agentDb'];
const string = (description, required = false) => ({ type: 'string', description, ...(required ? { required } : {}) });
const database = { database_id: string('Exact database id returned by db_create or db_list. Access is bound to your Harness session.', true) };
const query = { ...database, sql: string('One PostgreSQL statement. Use $1, $2 placeholders for values. Results: at most 1000 rows / 1 MiB; use LIMIT or pagination. Queries time out after 15 seconds.', true),
  parameters_json: string('JSON array of bound values; defaults to []. Example: ["навес",3].') };
const descriptions = [
  ['create', 'Создать базу', 'Create your own temporary PGX database for extracted keywords, facts, tables or development work. Use db_query for CREATE TABLE, then db_insert/db_query. Losing this beta storage is possible: export valuable results. TTL is an idle lease, renewed by queries; cleanup runs while Harness is running.',
    { label: string('Short purpose of this database.', true), ttl_seconds: { type: 'integer', description: 'Idle lease: 60–604800 seconds; default 86400 (24 hours).' } }],
  ['list', 'Базы агента', 'List databases owned by or explicitly shared with this Harness session. Also returns your session_id for db_share.', {}],
  ['query', 'SQL-запрос', 'Execute one SQL statement in a database available to your session. CREATE TABLE, INSERT, SELECT, UPDATE and DELETE are supported. Other sessions are isolated unless the owner explicitly shares access. Multiple statements and persistent transactions are not supported; every SQL connection is closed after the call. Result-limit/timeout errors do not prove that a write was rolled back.', query],
  ['insert', 'Записать строки', 'Insert 1–500 JSON objects into an existing table using bound values. All objects must have the same columns. Never interpolate extracted content into SQL.',
    { ...database, table: string('Simple lowercase table name or schema.table.', true), rows_json: string('JSON array of objects, at most 1 MiB. Example: [{"keyword":"навес","frequency":3}].', true) }],
  ['extend', 'Продлить хранение', 'Owner only: set a new idle lease starting now. Export important results before expiry.',
    { ...database, ttl_seconds: { type: 'integer', required: true, description: 'Lease duration: 60–604800 seconds.' } }],
  ['export', 'Экспорт данных', 'Run a bounded SQL query and save its rows as a private JSON or CSV file. File remains after database deletion. The returned local path can be read using file tools. Use JSON for exact values; CSV protects against spreadsheet formulas. Use LIMIT and pagination for larger exports.',
    { ...query, format: { type: 'string', enum: ['json', 'csv'], required: true, description: 'Output file format.' } }],
  ['share', 'Доступ к базе', 'Owner only: explicitly grant or revoke full SQL access for another Harness session (for example a subagent session id). Collaborators can query/write/export; only the owner can share, extend or drop the database.',
    { ...database, target_session_id: string('Exact session id of the intended collaborator.', true), revoke: { type: 'boolean', description: 'true to revoke; default false.' } }],
  ['drop', 'Удалить базу', 'Owner only: permanently delete this temporary database and its database role. Export results first. Existing exported files are retained.', database],
];

export function apply(ctx) {
  for (const [operation, title, description, parameters] of descriptions) {
    ctx.tools.register(defineTool({ name: 'db_' + operation, description, parameters,
      timeoutMs: 60000,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        try {
          const session = exec.agent?.session?.id;
          if (!session) throw new DbError('no_session', 'A Harness agent session is required.');
          const result = await ctx.agentDb.manager.run(operation, session, args, exec.signal);
          return { ok: true, ...result };
        } catch (error) {
          const message = error instanceof DbError ? error.message :
            /^[0-9A-Z]{5}$/.test(error.code ?? '') ? String(error.message).slice(0, 400) : 'Database operation failed; check the local PGX service.';
          console.error('[dsh-agent-db] tool:', operation, error.code ?? 'operation_error');
          return { ok: false, code: error.code ?? 'operation_error', message };
        }
      },
      presentCall: args => ({ card: 'generic', title, kind: operation === 'list' ? 'read' : 'other', rawInput: args.label ?? args.database_id ?? '' }),
    }));
  }
}
