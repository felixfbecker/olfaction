// TODO

import { Router } from 'express'
import { wrap } from 'async-middleware'
import * as git from '../git'
import { RepoRootSpec, CodeSmell } from '../models'
import * as HttpStatus from 'http-status-codes'
import { Client } from 'pg'
import sql from 'sql-template-strings'

export const createRestRouter = ({ repoRoot, db }: RepoRootSpec & { db: Client }): Router => {
    const router = Router()

    router.post<{ repository: string; commit: string }>(
        '/repositories/:repository/commits/:commit/codesmells',
        wrap(async (req, res) => {
            const { repository, commit } = req.params
            const { kind, message, locations } = req.body

            await git.validateRepository({ repository, repoRoot })
            await git.validateCommit({ repository, commit, repoRoot })
            const commitData = (await git.getCommits({ repository, commitShas: [commit], repoRoot })).get(
                commit
            )
            const result = await db.query(sql`
                INSERT INTO code_smells (kind, message, locations, commit_id, commit_date)
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

    router.get<{ repository: string; commit: string }>(
        '/repositories/:repository/commits/:commit/codesmells',
        wrap(async (req, res) => {
            const { repository, commit } = req.params

            await git.validateRepository({ repository, repoRoot })
            await git.validateCommit({ repository, commit, repoRoot })

            const result = await db.query(sql`
                SELECT *
                FROM code_smells
                WHERE repository = ${repository} AND commit_id = ${commit}
            `)

            const codeSmells = result.rows

            res.json(codeSmells)
        })
    )

    router.get<{ repository: string }>(
        '/repositories/:repository/codesmells',
        wrap(async (req, res) => {
            const { repository } = req.params
            const { kind } = req.query
            const query = sql`
                SELECT *
                FROM code_smells
                WHERE repository = ${repository}
                ORDER BY commit_date DESC
            `
            if (kind) {
                query.append(sql`AND kind = ${kind}`)
            }
            const result = await db.query<CodeSmell>(query)
            const codeSmells = result.rows

            res.json(codeSmells)
        })
    )
    return router
}
