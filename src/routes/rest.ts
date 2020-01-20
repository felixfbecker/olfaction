import { Router, Response, Request } from 'express'
import { wrap } from 'async-middleware'
import * as git from '../git'
import { RepoRootSpec, CodeSmell, RepoSpec, GitObjectID, UUID } from '../models'
import * as HttpStatus from 'http-status-codes'
import sql from 'sql-template-strings'
import gql from 'tagged-template-noop'
import { graphql } from 'graphql'
import { GraphQLHandler, createGraphQLContext } from './graphql'
import { dataOrErrors, DBContext } from '../util'
import { Connection } from 'graphql-relay'
import originalUrl from 'original-url'

/**
 * Adds an RFC5988 Link header to the HTTP response to support paginating the
 * given connection through URL search parameters.
 */
function addLinkHeaderForConnection(req: Request, res: Response, connection: Connection<unknown>): void {
    if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor) {
        const uri = new URL(originalUrl(req).full)
        uri.searchParams.set('after', connection.pageInfo.endCursor)
        res.setHeader('Link', `<${uri}>; rel="next"`)
    }
}
export const createRestRouter = ({
    repoRoot,
    dbPool,
    graphQLHandler,
}: RepoRootSpec & DBContext & { graphQLHandler: GraphQLHandler }): Router => {
    const router = Router()

    router.post<{ repository: string; commit: string }>(
        '/repositories/:repository/commits/:commit/code-smells',
        wrap(async (req, res) => {
            const { repository, commit } = req.params
            const { kind, message, locations } = req.body

            await git.checkRepositoryExists({ repository, repoRoot })
            await git.checkCommitExists({ repository, commit, repoRoot })
            const commitData = (await git.getCommits({ repository, commitOids: [commit], repoRoot })).get(
                commit
            )
            const result = await dbPool.query(sql`
                INSERT INTO code_smells (kind, "message", locations, commit_id, commit_date)
                VALUES (${kind}, ${message}, ${locations}, ${commit}, ${commitData!.committer.date})
                RETURNING id
            `)
            const codeSmell = {
                id: result.rows[0].id,
                kind,
                message,
                locations,
            }

            res.status(HttpStatus.CREATED).json(codeSmell)
        })
    )

    router.get<{}>(
        '/repositories',
        wrap(async (req, res) => {
            const { first, after } = req.query
            const query = gql`
                query($first: Int, $after: String) {
                    repositories(first: $first, after: $after) {
                        edges {
                            node {
                                name
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        first: first && parseInt(first, 10),
                        after,
                    },
                })
            )
            const connection: Connection<{ name: string }> = data.repositories
            addLinkHeaderForConnection(req, res, connection)
            const repositories = connection.edges.map(edge => edge.node)
            res.json(repositories)
        })
    )

    router.get<{ repository: string }>(
        '/repositories/:repository/commits',
        wrap(async (req, res) => {
            const { first, after, since, until, startRevision, messagePattern } = req.query
            const { repository } = req.params
            const query = gql`
                query(
                    $repository: String!
                    $startRevision: String
                    $messagePattern: String
                    $since: String
                    $until: String
                    $after: String
                    $first: Int
                ) {
                    repository(name: $repository) {
                        commits(
                            startRevision: $startRevision
                            messagePattern: $messagePattern
                            since: $since
                            until: $until
                            first: $first
                            after: $after
                        ) {
                            edges {
                                node {
                                    oid
                                    message
                                    author {
                                        name
                                        date
                                        email
                                    }
                                    committer {
                                        name
                                        date
                                        email
                                    }
                                    #parents
                                }
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        repository,
                        startRevision,
                        messagePattern,
                        since,
                        until,
                        first: first && parseInt(first, 10),
                        after,
                    },
                })
            )
            const connection: Connection<unknown> = data.repository.commits
            addLinkHeaderForConnection(req, res, connection)
            const commits = connection.edges.map(edge => edge.node)
            res.json(commits)
        })
    )

    router.get<{ repository: string; oid: GitObjectID }>(
        '/repositories/:repository/commits/:oid',
        wrap(async (req, res) => {
            const { repository, oid } = req.params
            const query = gql`
                query($repository: String!, $oid: GitObjectID!) {
                    repository(name: $repository) {
                        commit(oid: $oid) {
                            oid
                            message
                            author {
                                name
                                date
                                email
                            }
                            committer {
                                name
                                date
                                email
                            }
                            #parents
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        repository,
                        oid,
                    },
                })
            )
            res.json(data.repository.commit)
        })
    )

    router.get<{ id: UUID }>(
        '/code-smells/:id',
        wrap(async (req, res) => {
            const { id } = req.params
            const query = gql`
                query($id: ID!) {
                    codeSmell(id: $id) {
                        id
                        lifespan {
                            id
                            kind
                        }
                        message
                        locations {
                            file {
                                path
                            }
                            range {
                                start {
                                    line
                                    character
                                }
                                end {
                                    line
                                    character
                                }
                            }
                        }
                        predecessor {
                            id
                        }
                        successor {
                            id
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        id,
                    },
                })
            )
            res.json(data.codeSmell)
        })
    )

    router.get<{ repository: string }>(
        '/repositories/:repository/code-smell-lifespans',
        wrap(async (req, res) => {
            const { repository } = req.params
            const { kind, first, after } = req.query

            const query = gql`
                query($repository: String!, $kind: String, $first: Int, $after: String) {
                    repository(name: $repository) {
                        codeSmellLifespans(kind: $kind, first: $first, after: $after) {
                            edges {
                                node {
                                    id
                                    kind
                                    interval
                                    duration
                                }
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        repository,
                        kind,
                        first: first && parseInt(first, 10),
                        after,
                    },
                })
            )

            const connection: Connection<unknown> = data.repository.codeSmellLifespans
            const lifespans = connection.edges.map(edge => edge.node)
            addLinkHeaderForConnection(req, res, connection)
            res.json(lifespans)
        })
    )

    router.get<{ repository: string; oid: GitObjectID }>(
        '/repositories/:repository/commits/:oid/code-smells',
        wrap(async (req, res) => {
            const { first, after, kind } = req.query
            const { repository, oid } = req.params
            const query = gql`
                query($repository: String!, $oid: GitObjectID!, $kind: String, $after: String, $first: Int) {
                    repository(name: $repository) {
                        commit(oid: $oid) {
                            codeSmells(kind: $kind, first: $first, after: $after) {
                                edges {
                                    node {
                                        id
                                        lifespan {
                                            id
                                            kind
                                        }
                                        message
                                        locations {
                                            file {
                                                path
                                            }
                                            range {
                                                start {
                                                    line
                                                    character
                                                }
                                                end {
                                                    line
                                                    character
                                                }
                                            }
                                        }
                                        predecessor {
                                            id
                                        }
                                        successor {
                                            id
                                        }
                                    }
                                }
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                            }
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        repository,
                        oid,
                        kind,
                        first: first && parseInt(first, 10),
                        after,
                    },
                })
            )
            const connection: Connection<unknown> = data.repository.commit.codeSmells
            addLinkHeaderForConnection(req, res, connection)
            const codeSmells = connection.edges.map(edge => edge.node)
            res.json(codeSmells)
        })
    )

    router.get<{ id: UUID }>(
        '/code-smell-lifespans/:id',
        wrap(async (req, res) => {
            const { id } = req.params
            const query = gql`
                query($id: ID!) {
                    codeSmellLifespan(id: $id) {
                        id
                        kind
                        interval
                        duration
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        id,
                    },
                })
            )
            res.json(data.codeSmellLifespan)
        })
    )

    router.get<{ id: UUID }>(
        '/code-smell-lifespans/:id/instances',
        wrap(async (req, res) => {
            const { first, after } = req.query
            const { id } = req.params
            const query = gql`
                query($id: ID!, $after: String, $first: Int) {
                    codeSmellLifespan(id: $id) {
                        instances(first: $first, after: $after) {
                            edges {
                                node {
                                    id
                                    lifespan {
                                        id
                                        kind
                                    }
                                    message
                                    locations {
                                        file {
                                            path
                                        }
                                        range {
                                            start {
                                                line
                                                character
                                            }
                                            end {
                                                line
                                                character
                                            }
                                        }
                                    }
                                    predecessor {
                                        id
                                    }
                                    successor {
                                        id
                                    }
                                    commit {
                                        oid
                                        message
                                        author {
                                            name
                                            date
                                            email
                                        }
                                        committer {
                                            name
                                            date
                                            email
                                        }
                                        #parents
                                    }
                                }
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                }
            `
            const contextValue = createGraphQLContext({ dbPool, repoRoot })
            const data = dataOrErrors(
                await graphql({
                    ...graphQLHandler,
                    contextValue,
                    source: query,
                    variableValues: {
                        id,
                        first: first && parseInt(first, 10),
                        after,
                    },
                })
            )
            const connection: Connection<unknown> = data.codeSmellLifespan.instances
            addLinkHeaderForConnection(req, res, connection)
            const codeSmells = connection.edges.map(edge => edge.node)
            res.json(codeSmells)
        })
    )

    return router
}
