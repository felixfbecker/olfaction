// TODO

import { Router } from 'express'
import { wrap } from 'async-middleware'
import * as git from '../git'
import { RepoRootSpec, CodeSmell } from '../models'
import * as HttpStatus from 'http-status-codes'
import { Client } from 'pg'
import sql from 'sql-template-strings'
import gql from 'tagged-template-noop'
import { graphql } from 'graphql'
import { GraphQLHandler, createGraphQLContext } from './graphql'
import { dataOrErrors, DBContext } from '../util'
import LinkHeader from 'http-link-header'
import { Connection } from 'graphql-relay'
import originalUrl from 'original-url'

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

            await git.validateRepository({ repository, repoRoot })
            await git.validateCommit({ repository, commit, repoRoot })
            const commitData = (await git.getCommits({ repository, commitShas: [commit], repoRoot })).get(
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
                        first: (first && parseInt(first, 10)) || 50,
                        after,
                    },
                })
            )

            const connection: Connection<any> = data.repository.codeSmellLifespans
            const lifeSpans = connection.edges.map((edge: any) => edge.node)

            if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor) {
                const link = new LinkHeader()
                const uri = new URL(originalUrl(req))
                uri.searchParams.set('after', connection.pageInfo.endCursor)
                link.set({ uri: uri.href, rel: 'next' })
                res.setHeader('Link', link.toString())
            }
            res.json(lifeSpans)
        })
    )

    router.get<{ repository: string; commit: string }>(
        '/repositories/:repository/commits/:commit/code-smells',
        wrap((req, res) => {
            const { repository, commit } = req.params
        })
    )
    return router
}
