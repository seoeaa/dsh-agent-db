# dsh-agent-db

**English** | [Русский](README.ru.md)

Temporary PostgreSQL-compatible databases for **DeepSeek Harness** agents and
subagents. An agent creates its own database, stores keywords, facts and tables,
runs SQL, exports results to JSON/CSV, and deletes the database when finished.

The database engine is [PGX](https://github.com/pgrundev/pgx), written in Rust.
This plugin is a JavaScript ESM adapter providing eight native Harness tools.
PGX is installed separately and is not bundled with the plugin.

**Status: early release 0.1.0.** Validated on Linux with Node.js 25.2.1,
Harness **0.2.1-alpha.3**, Cordis **4.0.5-alpha.2**, and PGX **0.1.0-beta.1**.
The package requires Node.js 24 or later. Other Harness versions and operating
systems have not been verified. PGX beta is temporary storage: export valuable results.

## Installation

### 1. Prepare a dedicated PGX runtime

Install the CLI using the [official PGX instructions](https://pgx.dev/).
Create a **dedicated** runtime for this plugin. Do not use a shared server holding
important databases: on startup, the adapter revokes public CONNECT access to
the system databases.

```sh
install -d -m 700 "$HOME/.local/state/dsh-agent-db"
export PGX_HOME="$HOME/.local/state/dsh-agent-db/pgx"
pgx init --port 55439
pgx start
pgx doctor
```

Port 55439 must be available. Keep the listener restricted to loopback.
The adapter reads connection settings from `$PGX_HOME/config.json`; it does not
return the password to agents. The PGX beta.1 CLI requires the default `trust`
authentication for its Unix socket. Protect access with directory mode 0700;
TCP can use SCRAM. For persistent operation, you can configure a systemd user service.

### 2. Get and prepare the plugin

A compatible version of Harness must already be installed.

```sh
git clone --branch v0.1.0 https://github.com/seoeaa/dsh-agent-db.git
cd dsh-agent-db
npm ci --ignore-scripts --omit=optional
npm run setup:runtime -- "$(npm root -g)/@deepseek-ai/dsh"
npm run check
```

`setup:runtime` links Cordis and dsh-tools to the packages used by the installed
Harness, keeping a shared runtime instance. If Harness was installed another way,
pass its actual package directory. The script checks versions and does not replace
existing packages that point elsewhere. Check the links again after moving Harness
or changing its Node.js installation directory.

### 3. Enable the bundle and tools

From the plugin directory, install the package into the desired profile:

```sh
dsh plugin --profile web add "link:$(pwd)"
```

Enable the `@local/dsh-agent-db` bundle in the Harness plugin manager.
It adds the `agentDb` Host service. Then add the following tool entry to the
selected preset's `config.plugins`, keeping its existing entries:

```yaml
- id: tool-agent-db
  name: '@local/dsh-agent-db/tools'
```

To use custom paths, configure the `local-agent-db-service` service in the bundle:

```yaml
- insert:
    - id: local-agent-db-service
      name: '@local/dsh-agent-db'
      config:
        stateDirectory: /path/to/private/agent-db-state
        pgxHome: /path/to/dedicated/pgx
```

By default, state is stored in `~/.local/state/dsh-agent-db`, with PGX_HOME in its
`pgx` subdirectory. Each state directory must be managed by a single Host service.
Subagents need a preset with the same tool module. In a new conversation, check
that `db_create` and `db_list` are available: installing the package alone does not
attach its tools to a preset.

## Tools

| Tool | Purpose |
|---|---|
| `db_create(label, ttl_seconds?)` | Create a database and a separate SQL role; return its id |
| `db_list()` | List owned and explicitly shared databases; return the caller's session_id |
| `db_query(database_id, sql, parameters_json?)` | Run one SQL statement with `$1` parameters |
| `db_insert(database_id, table, rows_json)` | Insert an array of JSON objects into an existing table |
| `db_extend(database_id, ttl_seconds)` | Owner sets the retention period starting now |
| `db_export(database_id, sql, format, parameters_json?)` | Save query results to a local JSON/CSV file |
| `db_share(database_id, target_session_id, revoke?)` | Owner grants or revokes another session's SQL access |
| `db_drop(database_id)` | Owner deletes the database and its role; exported files remain |

Example task for an agent:

> Create a temporary database for keywords. Create a keywords table with keyword,
> source_url and frequency columns. Save the extracted keywords with db_insert,
> aggregate frequencies using SQL, export the results to CSV, and drop the database.
> Report the file path.

Example tool arguments after obtaining `database_id` from `db_create`:

```json
{"database_id":"<id from db_create>","sql":"CREATE TABLE keywords (keyword text NOT NULL, frequency integer NOT NULL)"}
```

```json
{"database_id":"<id from db_create>","table":"keywords","rows_json":"[{\"keyword\":\"canopy\",\"frequency\":3},{\"keyword\":\"canopy\",\"frequency\":4}]"}
```

```json
{"database_id":"<id from db_create>","sql":"SELECT keyword, SUM(frequency) AS frequency FROM keywords WHERE keyword = $1 GROUP BY keyword","parameters_json":"[\"canopy\"]"}
```

The model extracts text; PGX stores structured records and executes SQL.
For collaboration, a subagent reports its `session_id` and the owner calls
`db_share`. The recipient can read, modify and export data. Only the owner can
drop the database or manage access.

## Architecture and limits

- `index.js` creates the Host service, `tools.js` registers tools, and `manager.js`
  manages SQL roles, databases, the registry and cleanup through `pg`.
  Ownership comes from `exec.agent.session.id`, not a model-supplied argument.
  Each database has its own role without administrative privileges.
  Credentials are not returned by tools.
- These are tool access controls within a trusted local Harness. An agent with
  full shell access as the same OS user can read that user's files and settings.
- TTL is a sliding idle lease: 24 hours by default, configurable from 60 seconds
  to 7 days. Queries renew the lease before and after execution. Cleanup runs
  inside Harness every 30 seconds and at startup. This collector does not run
  while Harness is off. It is the plugin's TTL, separate from the PGX CLI's TTL.
- Up to 5 databases per owner and 32 in total. The queue holds up to 32 operations;
  operations run sequentially.
- One SQL statement per call, a 15-second timeout, and up to 1000 rows / 1 MiB of
  output. SQL input is limited to 64 KiB; parameters to 1 MiB / 10000 values.
  Exports use the same output limit. Use aggregation and pagination for larger results.
- `db_insert` accepts 1–500 objects with the same fields and up to 50 columns.
  Table names are limited to simple `table` or `schema.table` identifiers;
  values are bound parameters.
- Each SQL connection closes after its call. Transactions across calls and
  persistent `SET` changes are not supported. A timeout or output-limit error
  does not guarantee a completed write was rolled back; check before retrying.
- The registry containing credentials uses mode 0600; the state directory uses
  0700. Database name and OID are checked before access or deletion; unknown
  databases are not cleaned up.
- JSON/CSV files are saved under `stateDirectory/exports` with mode 0600, up to
  100 files per session. Dropping a database does not remove them. CSV protects
  cells against spreadsheet formulas; JSON preserves original values.
  Remove old exports separately.
- PGX beta is not a replacement for a primary production database. Cloning
  performance depends on the filesystem; the adapter does not promise ZFS CoW
  performance on ext4.

## Verification

```sh
npm run check
npm pack --dry-run
```

Before the first publication, 14 manual scenarios passed against real PGX:
parameterized SQL, session and role isolation, sharing and revocation, owner-only
operations, export, output limits, cancellation, lease extension and actual TTL
cleanup. A live Harness agent and its subagent, using Gemini 3.8 Flash, each
completed a create, write, query, export and drop workflow. Temporary databases
and roles were removed.
CI checks syntax and package contents. It does not run PGX or models.

## Licenses

The adapter is licensed under [MIT](LICENSE). The separately installed
[PGX](https://github.com/pgrundev/pgx) is distributed under AGPL-3.0;
its source code and binaries are not included in this repository.
