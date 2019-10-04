import express from 'express'
import { Request, Response } from 'express-serve-static-core'
import { wrap } from 'async-middleware'
import { Client } from 'pg'
import { SQL } from 'sql-template-strings'
import * as path from 'path'
import exec from 'execa'
import * as _fs from 'fs'
import * as HttpStatus from 'http-status-codes'
import execa from 'execa'
import { sortBy } from 'lodash'
import * as readline from 'readline'
import { fromNodeStream } from 'ix'
import { map, take, filter } from 'ix/asynciterable/pipe/index'
const fs = _fs.promises

const REPO_ROOT = process.env.REPO_ROOT || path.resolve('repos')

const resolveRepoPath = (repo: string) => path.join(REPO_ROOT, repo)

class AbortError {
    readonly name = 'AbortError'
}

class UnknownCommitError extends Error {
    constructor({ repo, commit }: { repo: string; commit: string }) {
        super(`Commit ${commit} of repository ${repo} is not known to server. Please make sure the commit was pushed with \`git push\` first.`)
    }
}

class UnknownRepositoryError extends Error {
    readonly name = 'UnknownRepositoryError'
    readonly status = HttpStatus.NOT_FOUND

    constructor({ repository: repository }: { repository: string }) {
        super(`Repository ${repository} is not known to server. Please make sure the repository was pushed with \`git push\` first.`)
    }
}

async function validateCommit({ repository, commit }: { repository: string; commit: string }) {
    try {
        await exec('git', ['cat-file', `${commit}^{commit}`, '--'], { cwd: resolveRepoPath(repository) })
    } catch (err) {
        if (err.killed) {
            return
        }
        if (err.exitCode === 128 && err.stderr && err.stderr.includes('Not a valid object name')) {
            throw new UnknownCommitError({ repo: repository, commit })
        }
        throw err
    }
}

async function getCommitDate({ repository, commit }: { repository: string; commit: string }): Promise<string> {
    try {
        const { stdout } = await exec('git', ['show', '--format=%cI', commit, '--'], { cwd: resolveRepoPath(repository) })
        return stdout.trim()
    } catch (err) {
        if (err.killed) {
            throw new AbortError()
        }
        if (err.exitCode === 128 && err.stderr && err.stderr.includes('bad revision')) {
            throw new UnknownCommitError({ repo: repository, commit })
        }
        throw err
    }
}

async function validateRepository({ repository }: { repository: string }) {
    try {
        await fs.stat(resolveRepoPath(repository))
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

interface CodeSmell {
    kind: string
    commit: string
}

async function sortTopologically(codeSmells: CodeSmell[], repository: string): Promise<CodeSmell[]> {
    // Sort code smells by commit order
    const commitIds = new Set(codeSmells.map(codeSmell => codeSmell.commit))
    const sortedCommitIds = fromNodeStream(execa('git', ['rev-list', '--topo-order', ...commitIds], { cwd: resolveRepoPath(repository) }).stdout!).pipe(
        split('\n'),
        filter(commitId => commitIds.has(commitId)),
        take(commitIds.size)
    )
    const commitIndexes = new Map<string, number>()
    let index = 0
    for await (const commitId of sortedCommitIds) {
        commitIndexes.set(commitId, index)
        index++
    }
    return sortBy(codeSmells, codeSmell => commitIndexes.get(codeSmell.commit))
}

async function main() {
    const app = express()

    const client = new Client()
    await client.connect()

    app.post<{ repository: string; commit: string }>(
        '/repositories/:repository/commits/:commit/codesmells',
        wrap(async (req, res) => {
            const { repository, commit } = req.params
            const { kind, message, locations } = req.body

            await validateRepository({ repository })
            await validateCommit({ repository, commit })
            const commitDate = await getCommitDate({ repository, commit })
            const result = await client.query(SQL`
                INSERT INTO code_smells (kind, message, locations, commit_id, commit_date)
                VALUES (${kind}, ${message}, ${locations}, ${commit}, ${commitDate})
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

    app.get<{ repository: string; commit: string }>(
        '/repositories/:repository/commits/:commit/codesmells',
        wrap(async (req, res) => {
            const { repository, commit } = req.params

            await validateRepository({ repository })
            await validateCommit({ repository, commit })

            const result = await client.query(SQL`
                SELECT *
                FROM code_smells
                WHERE repository = ${repository} AND commit_id = ${commit}
            `)

            const codeSmells = result.rows

            res.json(codeSmells)
        })
    )

    app.get<{ repository: string }>(
        '/repositories/:repository/codesmells',
        wrap(async (req, res) => {
            const { repository } = req.params
            const { kind } = req.query
            const query = SQL`
                SELECT *
                FROM code_smells
                WHERE repository = ${repository}
                ORDER BY commit_date DESC
            `
            if (kind) {
                query.append(SQL`AND kind = ${kind}`)
            }
            const result = await client.query<CodeSmell>(query)
            const codeSmells = result.rows

            res.json(codeSmells)
        })
    )
}

/**
 * Turns a sequence of text chunks into a sequence of lines
 * (where lines are separated by newlines)
 *
 * @returns an async iterable
 */
const split = (seperator: string) =>
    async function*(chunksAsync: AsyncIterable<string | Buffer>): AsyncIterable<string> {
        let previous = ''
        for await (const chunk of chunksAsync) {
            previous += chunk.toString()
            let eolIndex
            while ((eolIndex = previous.indexOf(seperator)) >= 0) {
                const line = previous.slice(0, eolIndex)
                yield line
                previous = previous.slice(eolIndex + 1)
            }
        }
        if (previous.length > 0) {
            yield previous
        }
    }
