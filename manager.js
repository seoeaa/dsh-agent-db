import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';

const { Pool, Query } = pg;
const PREFIX = /^dshdb_[a-f0-9]{24}$/;
const MAX_ROWS = 1000;
const MAX_BYTES = 1024 * 1024;
export class DbError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = message => { throw new DbError('invalid_argument', message); };
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v);
const sessionKey = id => createHash('sha256').update(id).digest('hex').slice(0, 24);

export class AgentDbManager {
  constructor({ stateDirectory, pgxHome, queryTimeoutMs = 15000, sweepIntervalMs = 30000 }) {
    this.stateDirectory = stateDirectory;
    this.pgxHome = pgxHome;
    this.queryTimeoutMs = queryTimeoutMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.registryPath = path.join(stateDirectory, 'registry.json');
    this.records = new Map();
    this.pools = new Map();
    this.tail = Promise.resolve();
    this.pending = 0;
    this.closed = false;
    this.storageFailed = false;
  }

  async init() {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.stateDirectory, 0o700);
    const config = JSON.parse(await fs.readFile(path.join(this.pgxHome, 'config.json'), 'utf8'));
    this.connection = { host: '127.0.0.1', port: config.port, user: 'postgres', password: config.password,
      database: 'postgres', connectionTimeoutMillis: 5000, query_timeout: this.queryTimeoutMs,
      application_name: 'dsh-agent-db-admin' };
    this.admin = new Pool({ ...this.connection, max: 1, idleTimeoutMillis: 30000 });
    this.admin.on('error', error => console.error('[dsh-agent-db] admin connection:', error.code ?? 'connection_error'));
    try {
      const registry = JSON.parse(await fs.readFile(this.registryPath, 'utf8'));
      if (registry.version !== 1 || !Array.isArray(registry.databases)) throw new Error('Invalid agent database registry');
      for (const record of registry.databases) {
        if (!PREFIX.test(record.id) || record.role !== record.id || typeof record.owner !== 'string' ||
            typeof record.password !== 'string' || !Number.isFinite(record.expiresAt) ||
            !Number.isInteger(record.ttlSeconds) || !Number.isInteger(record.oid) ||
            !Array.isArray(record.sharedWith) || this.records.has(record.id)) throw new Error('Invalid agent database record');
        this.records.set(record.id, record);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.admin.query('SELECT 1');
    // This dedicated runtime holds no production databases. New branches revoke PUBLIC too.
    for (const db of ['postgres', 'template1', 'template0'])
      await this.admin.query(`REVOKE CONNECT ON DATABASE ${quote(db)} FROM PUBLIC`);
    this.timer = setInterval(() => {
      void this.serialize(() => this.sweep()).catch(error => console.error('[dsh-agent-db] cleanup:', error.code ?? 'cleanup_error'));
    }, this.sweepIntervalMs);
    this.timer.unref();
    await this.serialize(() => this.sweep());
  }

  serialize(work) {
    if (this.closed || this.storageFailed) return Promise.reject(new DbError('unavailable', 'Database manager is unavailable.'));
    if (this.pending >= 32) return Promise.reject(new DbError('busy', 'Database queue is full; retry later.'));
    this.pending++;
    const task = this.tail.then(() => {
      if (this.storageFailed) throw new DbError('unavailable', 'Database registry could not be saved.');
      return work();
    });
    this.tail = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }

  async save() {
    const temporary = this.registryPath + '.tmp';
    try {
      await fs.writeFile(temporary, json({ version: 1, databases: [...this.records.values()] }) + '\n', { mode: 0o600 });
      await fs.rename(temporary, this.registryPath);
    } catch (error) { this.storageFailed = true; throw error; }
  }

  ttl(value = 86400) {
    if (!Number.isInteger(value) || value < 60 || value > 604800) invalid('ttl_seconds must be an integer from 60 to 604800.');
    return value;
  }

  view(record) {
    return { id: record.id, label: record.label, owner_session_id: record.owner,
      shared_with: record.sharedWith, expires_at: new Date(record.expiresAt).toISOString(),
      ttl_seconds: record.ttlSeconds, state: record.state, storage: 'temporary-pgx' };
  }

  async owned(id, caller, ownerOnly = false) {
    const record = this.records.get(id);
    if (!record || (record.owner !== caller && (ownerOnly || !record.sharedWith.includes(caller))))
      throw new DbError('not_found', 'Database is not available to this session.');
    if (record.state !== 'ready') throw new DbError('not_ready', 'Database is being created or removed.');
    if (record.expiresAt <= Date.now()) throw new DbError('expired', 'Database lease expired.');
    const found = await this.admin.query('SELECT oid FROM pg_database WHERE datname = $1', [id]);
    if (Number(found.rows[0]?.oid) !== record.oid) throw new DbError('identity_changed', 'Database identity changed; refusing access.');
    return record;
  }

  async touch(record, ttlSeconds = record.ttlSeconds) {
    record.ttlSeconds = ttlSeconds;
    record.expiresAt = Date.now() + ttlSeconds * 1000;
    await this.save();
  }

  async create(caller, label, ttlSeconds) {
    if (typeof label !== 'string' || !label.trim() || label.length > 120) invalid('label must contain 1–120 characters.');
    ttlSeconds = this.ttl(ttlSeconds);
    if ([...this.records.values()].filter(r => r.owner === caller).length >= 5 || this.records.size >= 32)
      throw new DbError('quota_exceeded', 'Limit: 5 databases per session and 32 for this plugin.');
    const id = 'dshdb_' + randomBytes(12).toString('hex');
    const record = { id, role: id, password: randomBytes(24).toString('hex'), owner: caller,
      label: label.trim(), ttlSeconds, expiresAt: Date.now() + ttlSeconds * 1000,
      sharedWith: [], oid: 0, state: 'creating' };
    this.records.set(id, record);
    await this.save(); // Record ownership before issuing DDL, including interrupted creates.
    try {
      await this.admin.query(`CREATE ROLE ${quote(id)} LOGIN PASSWORD ${literal(record.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2`);
      await this.admin.query(`ALTER ROLE ${quote(id)} SET statement_timeout = '${this.queryTimeoutMs}ms'`);
      await this.admin.query(`ALTER ROLE ${quote(id)} SET lock_timeout = '3000ms'`);
      await this.admin.query(`ALTER ROLE ${quote(id)} SET idle_in_transaction_session_timeout = '15000ms'`);
      await this.admin.query(`CREATE DATABASE ${quote(id)} OWNER ${quote(id)} TEMPLATE template0`);
      record.oid = Number((await this.admin.query('SELECT oid FROM pg_database WHERE datname = $1', [id])).rows[0].oid);
      await this.save();
      await this.admin.query(`REVOKE ALL ON DATABASE ${quote(id)} FROM PUBLIC`);
      record.state = 'ready';
      await this.save();
      return this.view(record);
    } catch (error) {
      record.state = 'deleting';
      await this.save();
      // Keep failed creates registered for recovery; never delete an unverified database.
      throw error;
    }
  }

  pool(record) {
    if (!this.pools.has(record.id)) {
      const pool = new Pool({ ...this.connection, database: record.id, user: record.role,
        // pg's query_timeout installs a callback that swallows Query error events
        // and accumulates rows. The streaming path owns its timer and row budget.
        password: record.password, query_timeout: 0, max: 1, idleTimeoutMillis: 10000, maxUses: 50,
        application_name: 'dsh-agent-db-query' });
      pool.on('error', error => console.error('[dsh-agent-db] query connection:', error.code ?? 'connection_error'));
      this.pools.set(record.id, pool);
    }
    return this.pools.get(record.id);
  }

  parseJson(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) invalid('JSON input exceeds 1 MiB.');
    try { return JSON.parse(value); } catch { invalid('Input must be valid JSON.'); }
  }

  async queryRecord(record, sql, values, signal) {
    if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > 65536) invalid('sql must contain 1–65536 bytes.');
    if (!Array.isArray(values) || values.length > 10000 || Buffer.byteLength(json(values)) > MAX_BYTES)
      invalid('parameters_json must be an array within the input limit.');
    signal?.throwIfAborted();
    const client = await this.pool(record).connect();
    let destroyed = false;
    let timer;
    let abort;
    try {
      return await new Promise((resolve, reject) => {
        let bytes = 0;
        const rows = [];
        const fail = error => {
          if (destroyed) return;
          destroyed = true;
          void this.admin.query('SELECT pg_cancel_backend($1)', [client.processID]).catch(cancelError =>
            console.error('[dsh-agent-db] query cancellation:', cancelError.code ?? 'cancel_error'));
          // Close rather than return a timed-out/incomplete connection to the pool.
          client.release(true);
          reject(error);
        };
        abort = () => fail(new DbError('cancelled', 'Query cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => fail(new DbError('query_timeout', 'Query exceeded its time limit.')), this.queryTimeoutMs);
        // Extended protocol enforces one statement, even with an empty parameter list.
        const query = client.query(new Query({ text: sql, values, queryMode: 'extended' }));
        query.on('row', row => {
          bytes += Buffer.byteLength(json(row));
          if (rows.length >= MAX_ROWS || bytes > MAX_BYTES) fail(new DbError('result_limit', 'Result exceeds 1000 rows or 1 MiB; use LIMIT, aggregation, or pagination. Writes may already have executed.'));
          else rows.push(row);
        });
        query.on('error', reject);
        query.on('end', result => resolve({ command: result.command, row_count: result.rowCount,
          columns: result.fields.map(field => field.name), rows }));
      });
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      // Close every SQL session: SET ROLE, SET search_path and open transactions cannot leak to another caller.
      if (!destroyed) client.release(true);
    }
  }

  async query(caller, args, signal) {
    const record = await this.owned(args.database_id, caller);
    const values = this.parseJson(args.parameters_json, []);
    await this.touch(record);
    const result = await this.queryRecord(record, args.sql, values, signal);
    await this.touch(record);
    return { database_id: record.id, ...result };
  }

  async insert(caller, args, signal) {
    const rows = this.parseJson(args.rows_json);
    if (!Array.isArray(rows) || !rows.length || rows.length > 500) invalid('rows_json must contain 1–500 objects.');
    const names = typeof args.table === 'string' ? args.table.split('.') : [];
    if (names.length < 1 || names.length > 2 || names.some(n => !/^[a-z_][a-z0-9_]{0,62}$/.test(n))) invalid('table must be a simple table or schema.table identifier.');
    if (!rows[0] || Array.isArray(rows[0]) || typeof rows[0] !== 'object') invalid('Each row must be an object.');
    const columns = Object.keys(rows[0]);
    if (!columns.length || columns.length > 50 || columns.some(n => !/^[a-z_][a-z0-9_]{0,62}$/.test(n))) invalid('Use 1–50 simple column identifiers.');
    const values = [];
    const tuples = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== columns.length || columns.some(n => !Object.hasOwn(row, n))) invalid('All rows must contain the same columns.');
      return '(' + columns.map(column => { values.push(row[column]); return '$' + values.length; }).join(',') + ')';
    });
    return this.query(caller, { database_id: args.database_id,
      sql: `INSERT INTO ${names.map(quote).join('.')} (${columns.map(quote).join(',')}) VALUES ${tuples.join(',')}`,
      parameters_json: json(values) }, signal);
  }

  async export(caller, args, signal) {
    if (!['json', 'csv'].includes(args.format)) invalid('format must be json or csv.');
    const result = await this.query(caller, args, signal);
    let content;
    if (args.format === 'json') content = JSON.stringify(result.rows, null, 2) + '\n';
    else {
      const cell = value => {
        let text = value === null || value === undefined ? '' : typeof value === 'object' ? json(value) : String(value);
        // Spreadsheet-safe CSV; raw values remain available in JSON exports.
        if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      };
      content = [result.columns.map(cell).join(','), ...result.rows.map(row => result.columns.map(c => cell(row[c])).join(','))].join('\r\n') + '\r\n';
    }
    const directory = path.join(this.stateDirectory, 'exports', sessionKey(caller));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.readdir(directory)).length >= 100)
      throw new DbError('export_quota', 'Limit: 100 retained exports per session. Move or remove older exports first.');
    const filename = path.join(directory, `${result.database_id}-${Date.now()}-${randomBytes(4).toString('hex')}.${args.format}`);
    await fs.writeFile(filename, content, { mode: 0o600, flag: 'wx' });
    return { database_id: result.database_id, path: filename, rows: result.rows.length,
      bytes: Buffer.byteLength(content), format: args.format, retained_after_database_drop: true };
  }

  async share(caller, args) {
    const record = await this.owned(args.database_id, caller, true);
    if (typeof args.target_session_id !== 'string' || !args.target_session_id || args.target_session_id.length > 200) invalid('target_session_id is required.');
    if (args.revoke) record.sharedWith = record.sharedWith.filter(id => id !== args.target_session_id);
    else if (args.target_session_id !== caller && !record.sharedWith.includes(args.target_session_id)) {
      if (record.sharedWith.length >= 16) throw new DbError('quota_exceeded', 'Limit: 16 collaborators.');
      record.sharedWith.push(args.target_session_id);
    }
    await this.save();
    return this.view(record);
  }

  async remove(record) {
    if (!PREFIX.test(record.id) || record.role !== record.id) throw new DbError('invalid_identity', 'Invalid managed database identity.');
    const found = await this.admin.query('SELECT oid FROM pg_database WHERE datname = $1', [record.id]);
    if (found.rowCount && Number(found.rows[0].oid) !== record.oid)
      throw new DbError('identity_changed', 'Database identity changed; refusing removal.');
    record.state = 'deleting';
    await this.save();
    const pool = this.pools.get(record.id);
    if (pool) { await pool.end(); this.pools.delete(record.id); }
    if (found.rowCount) await this.admin.query(`DROP DATABASE ${quote(record.id)} WITH (FORCE)`);
    await this.admin.query(`DROP ROLE IF EXISTS ${quote(record.role)}`);
    this.records.delete(record.id);
    await this.save();
    return { database_id: record.id, deleted: true };
  }

  async sweep() {
    for (const record of [...this.records.values()]) {
      if (record.expiresAt <= Date.now() || record.state !== 'ready') {
        try { await this.remove(record); }
        catch (error) { console.error('[dsh-agent-db] retained cleanup candidate:', record.id, error.code ?? 'cleanup_error'); }
      }
    }
  }

  async run(operation, caller, args = {}, signal) {
    if (typeof caller !== 'string' || !caller) throw new DbError('no_session', 'A Harness agent session is required.');
    return this.serialize(async () => {
      signal?.throwIfAborted();
      switch (operation) {
        case 'create': return this.create(caller, args.label, args.ttl_seconds);
        case 'list': return { session_id: caller, databases: [...this.records.values()].filter(r => r.owner === caller || r.sharedWith.includes(caller)).map(r => this.view(r)) };
        case 'query': return this.query(caller, args, signal);
        case 'insert': return this.insert(caller, args, signal);
        case 'export': return this.export(caller, args, signal);
        case 'share': return this.share(caller, args);
        case 'extend': {
          const record = await this.owned(args.database_id, caller, true);
          await this.touch(record, this.ttl(args.ttl_seconds));
          return this.view(record);
        }
        case 'drop': return this.remove(await this.owned(args.database_id, caller, true));
        default: invalid('Unknown database operation.');
      }
    });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.tail;
    await Promise.all([...this.pools.values()].map(pool => pool.end()));
    if (this.admin) await this.admin.end();
  }
}
