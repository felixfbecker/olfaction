# Server for Code Smell Data

WIP

## Build

```sh
npm install
npm run build
```

## Start

```sh
npm start
```

## Environment variables

| Name         | Default     | Description                                                      |
| ------------ | ----------- | ---------------------------------------------------------------- |
| `PORT`       | `4040`      | Port for the HTTP API server to listen on                        |
| `REPO_ROOT`  | `./repos`   | Root directory where to find and store uploaded git repositories |
| `PGHOST`     | `localhost` | Postgres database host                                           |
| `PGPORT`     | `5432`      | Postgres database host                                           |
| `PGUSER`     |             | Postgres database user name                                      |
| `PGPASSWORD` |             | Postgres database password                                       |
| `PGDATABASE` |             | Postgres database name                                           |

## Requirements

- NodeJS >=13.6.0
- PostgreSQL 12.1

## Set up database

Make sure the above environment variables are set.

Create a database with PostgreSQL:

```sh
createdb olfaction
```

Then initialize the schema:

```sh
psql < ./schema/schema.sql
```

Performance recommendation:
Raise `work_mem` from its default of 4MB in PostgreSQL config, e.g. to `1 GB` (depending on available memory).
