# Server for Code Smell Data

Olfaction is a server with storage backend for code smell research data.
It exposes GraphQL and REST APIs over stored code smells and the version control information of analyzed repositories.

## Build

```sh
npm install
npm run build
```

## Start

```sh
npm start
```

Then navigate to http://localhost:4040/graphql to access the interactive query console.

## Environment variables

The following environment variables are used to configure the server:

| Name               | Default     | Description                                                                                                 |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `HOST`             | `localhost` | Host for the HTTP API server to listen on                                                                   |
| `PORT`             | `4040`      | Port for the HTTP API server to listen on                                                                   |
| `REPO_ROOT`        | `./repos`   | Root directory where to find and store uploaded git repositories                                            |
| `PGHOST`           | `localhost` | Postgres database host                                                                                      |
| `PGPORT`           | `5432`      | Postgres database host                                                                                      |
| `PGUSER`           |             | Postgres database user name                                                                                 |
| `PGPASSWORD`       |             | Postgres database password                                                                                  |
| `PGDATABASE`       |             | Postgres database name                                                                                      |
| `BASIC_AUTH_USERS` |             | If set, restricts access through HTTP basic auth. JSON object of usernames as keys and passwords as values. |

Additionally, the optional OpenTracing support using Jaeger is configured through environment variables documented [in the Jaeger client documentation](https://github.com/jaegertracing/jaeger-client-node#environment-variables).
To disable OpenTracing completely, `JAEGER_DISABLED` can be set to `true`.

## Requirements

The following tools need to be installed for the server:

- [NodeJS](https://nodejs.org/) 13.6.0
- [Git](https://git-scm.com/) 2.25.0
- [PostgreSQL](https://www.postgresql.org/) 12.1

## Docker image

A docker image is also available for the server (does not include the PostgreSQL database).
Example command to run the server on macOS, with a Postgres database running on the Docker host:

```sh
docker run --init --rm --name olfaction -p 4040:4040 --env PGHOST=host.docker.internal --env PGUSER=$USER --env PGDATABASE=olfaction felixfbecker/olfaction
```

The way to run the Docker image varies by platform. Please refer to the Docker documentation for more information.

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

To optimize performance, it is recommended to tweak the settings postgresql.conf depending on the available system resources.
