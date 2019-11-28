import * as path from 'path'
import exec from 'execa'
import * as fs from 'mz/fs'
import { AbortError } from './abort'
import { RepoSpec, CommitSpec, SHA, FileSpec, RepoRootSpec, CodeSmell, File } from './models'
import { UnknownRepositoryError, UnknownCommitError } from './errors'
import { take, filter } from 'ix/asynciterable/pipe/index'
import execa from 'execa'
import { sortBy } from 'lodash'
import { fromNodeStream } from 'ix'

export async function filterValidCommits({
    repository,
    commitShas,
    repoRoot,
}: {
    repoRoot: string
    repository: string
    commitShas: SHA[]
}): Promise<SHA[]> {
    try {
        const { stdout } = await exec('git', ['rev-list', '--ignore-missing', '--no-walk', '--stdin', '--'], {
            cwd: path.join(repoRoot, repository),
            input: commitShas.filter(c => /[a-f0-9]{40}/.test(c)).join('\n'),
        })
        return stdout.split('\n').filter(Boolean)
    } catch (err) {
        if (err.killed) {
            throw new AbortError()
        }
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function validateCommit({
    repository,
    commit,
    repoRoot,
}: {
    repoRoot: string
    repository: string
    commit: SHA
}): Promise<void> {
    const filtered = await filterValidCommits({ repository, commitShas: [commit], repoRoot })
    if (filtered.length === 0) {
        throw new UnknownCommitError({ repository, commit })
    }
}

export async function getFileContent({
    repoRoot,
    repository,
    commit,
    file,
}: RepoRootSpec & RepoSpec & FileSpec & CommitSpec): Promise<Buffer> {
    const { stdout } = await exec('git', ['show', `${commit}:${file}`], {
        encoding: null,
        cwd: path.join(repoRoot, repository),
    })
    return stdout
}

export interface Signature {
    name: string
    email: string
    /** Strict ISO date string (including timezone) */
    date: string
}

export interface Commit {
    repository: string
    sha: SHA
    author: Signature
    committer: Signature
    message: string
}

enum FormatTokens {
    commitSha = '%H',
    newLine = '%n',
    authorName = '%aN',
    authorEmail = '%aE',
    authorIsoDateStrict = '%aI',
    committerName = '%cN',
    committerEmail = '%cE',
    committerIsoDateStrict = '%cI',
    bodyRaw = '%B',
}
const commitFormat: string = [
    FormatTokens.commitSha,
    FormatTokens.authorName,
    FormatTokens.authorEmail,
    FormatTokens.authorIsoDateStrict,
    FormatTokens.committerName,
    FormatTokens.committerEmail,
    FormatTokens.committerIsoDateStrict,
    FormatTokens.bodyRaw,
].join(FormatTokens.newLine)

export async function getCommits({
    repoRoot,
    repository,
    commitShas,
}: {
    repoRoot: string
    repository: string
    commitShas: string[]
}): Promise<ReadonlyMap<SHA, Commit>> {
    // Bulk-validate the commits first, because git show fails hard on bad revisions
    const filteredCommitShas = await filterValidCommits({ repoRoot, repository, commitShas })
    try {
        const { stdout } = await exec(
            'git',
            [
                'show',
                '--no-decorate',
                '--no-patch',
                '--no-color',
                '-z', // seperate commits with NULL bytes
                `--format=${commitFormat}`,
                ...filteredCommitShas,
                '--',
            ],
            { cwd: path.join(repoRoot, repository) }
        )
        const commitChunks = stdout.split('\0')
        const commitsBySha = new Map<SHA, Commit>()
        for (const commitChunk of commitChunks) {
            const [
                sha,
                authorName,
                authorEmail,
                authorDate,
                committerName,
                committerEmail,
                committerDate,
                ...messageLines
            ] = commitChunk.split('\n')
            commitsBySha.set(sha, {
                repository,
                sha,
                author: {
                    name: authorName,
                    email: authorEmail,
                    date: authorDate,
                },
                committer: {
                    name: committerName,
                    email: committerEmail,
                    date: committerDate,
                },
                message: messageLines.join('\n'),
            })
        }
        return commitsBySha
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function getFileContents({
    repoRoot,
    repository,
    files,
}: {
    repoRoot: string
    repository: string
    files: (CommitSpec & FileSpec)[]
}): Promise<(string | null)[]> {
    const fileStrings = files.map(f => `${f.commit}:${f.file}`)
    try {
        const { stdout } = await exec('git', ['cat-file', '--batch', `--format=>>>%(rest)`], {
            cwd: path.join(repoRoot, repository),
            input: fileStrings.map(f => `${f} ${f}`).join('\n'),
        })
        const lines = stdout.split('\n')
        let fileStringIndex = 0
        let start = 0
        const contents: (string | null)[] = []
        for (const [lineNo, line] of lines.entries()) {
            if (line === '>>>' + fileStrings[fileStringIndex]) {
                const end = lineNo - 1
                contents.push(lines.slice(start, end).join('\n'))
                start = lineNo + 1
                fileStringIndex++
            } else if (line === '>>>' + fileStrings[fileStringIndex] + ' missing') {
                contents.push(null)
                fileStringIndex++
                start = lineNo + 1
            }
        }
        return contents
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function listFiles({
    repository,
    commit,
    repoRoot,
}: {
    repository: string
    commit: SHA
    repoRoot: string
}): Promise<File[]> {
    try {
        const { stdout } = await exec('git', ['ls-tree', '-r', '--name-only', '--full-name', commit], {
            cwd: path.resolve(repoRoot, repository),
        })
        return stdout.split('\n').map(path => ({ path }))
    } catch (err) {
        if (err.killed) {
            throw new AbortError()
        }
        if (err.exitCode === 128 && err.stderr && err.stderr.includes('fatal: not a tree object')) {
            throw new UnknownCommitError({ repository, commit })
        }
        throw err
    }
}

export async function validateRepository({ repository, repoRoot }: { repository: string; repoRoot: string }) {
    try {
        await fs.stat(path.join(repoRoot, repository))
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new UnknownRepositoryError({ repository })
        }
        throw err
    }
}

export async function listRepositories({ repoRoot }: { repoRoot: string }): Promise<string[]> {
    return await fs.readdir(repoRoot)
}

export async function init({
    repoRoot,
    repository,
}: {
    repoRoot: string
    repository: string
}): Promise<void> {
    const repo = path.resolve(repoRoot, repository)
    await fs.mkdir(repo)
    await exec('git', ['init', '--bare'])
    // Allow git push
    await exec('git', ['config', '--bool', 'http.receivepack', 'true'])
}

export async function sortTopologically(
    codeSmells: CodeSmell[],
    repository: string,
    repoRoot: string
): Promise<CodeSmell[]> {
    // Sort code smells by commit order
    const commitIds = new Set(codeSmells.map(codeSmell => codeSmell.commit))
    const sortedCommitIds = fromNodeStream(
        execa('git', ['rev-list', '--topo-order', ...commitIds], { cwd: path.join(repository, repoRoot) })
            .stdout!
    ).pipe(
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
