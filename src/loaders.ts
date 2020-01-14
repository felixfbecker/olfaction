import { Client } from 'pg'
import DataLoader from 'dataloader'
import sql from 'sql-template-strings'
import * as git from './git'
import { groupBy, last } from 'lodash'
import {
    CodeSmell,
    RepoSpec,
    CommitSpec,
    FileSpec,
    File,
    CodeSmellLifespan,
    CodeSmellLifespanSpec,
    Commit,
    CodeSmellSpec,
} from './models'
import { NullFields, base64encode, parseCursor, isNullArray, asError, logDuration } from './util'
import assert from 'assert'
import { Connection, Edge, ConnectionArguments } from 'graphql-relay'
import { IterableX } from 'ix/iterable'
import { UnknownCodeSmellError, UnknownCommitError, UnknownCodeSmellLifespanError } from './errors'
import objectHash from 'object-hash'
import mapPromise from 'p-map'

export type ForwardConnectionArguments = Pick<ConnectionArguments, 'first' | 'after'>

export interface Loaders {
    codeSmell: {
        /** Loads a code smell by ID. */
        byId: DataLoader<CodeSmell['id'], CodeSmell>
        byOrdinal: DataLoader<CodeSmellLifespanSpec & Pick<CodeSmell, 'ordinal'>, CodeSmell>
        /** Loads the entire life span of a given lifespan ID. */
        forLifespan: DataLoader<CodeSmellLifespanSpec & ForwardConnectionArguments, Connection<CodeSmell>>
        forCommit: DataLoader<RepoSpec & CommitSpec & ForwardConnectionArguments, Connection<CodeSmell>>
    }
    codeSmellLifespan: {
        /** Loads a code smell lifespan by ID. */
        byId: DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan>
        /** Loads the code smell lifespans in a given repository. */
        forRepository: DataLoader<
            RepoSpec & { kind?: string } & ForwardConnectionArguments,
            Connection<CodeSmellLifespan>
        >
    }

    commit: {
        bySha: DataLoader<RepoSpec & CommitSpec, Commit>

        /** Loads the existing commit SHAs in a repository */
        forRepository: DataLoader<
            RepoSpec & ForwardConnectionArguments & { grep?: string },
            Connection<Commit>
        >
    }

    files: DataLoader<RepoSpec & CommitSpec, File[]>
    fileContent: DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>
}

const repoAtCommitCacheKeyFn = ({ repository, commit }: RepoSpec & CommitSpec): string =>
    `${repository}@${commit}`
const connectionArgsKeyFn = ({ first, after }: ForwardConnectionArguments): string => `*${after}+${first}`

/**
 * Creates a connection from a DB result page that was fetched with one more
 * item before and after than requested (if possible), which will be stripped
 * and used to determine pagination info.
 *
 * @param result The result array from the DB with one more item at the beginning and end.
 * @param args The pagination options that were given.
 * @param cursorKey The key that was used to order the result and is used to determine the cursor.
 */
const connectionFromOverfetchedResult = <T extends object>(
    result: T[],
    { first, after }: ForwardConnectionArguments,
    cursorKey: keyof T
): Connection<T> => {
    const edges: Edge<T>[] = IterableX.from(result)
        .skip(after ? 1 : 0)
        .take(first ?? Infinity)
        .map(node => ({ node, cursor: base64encode(cursorKey + ':' + node[cursorKey]) }))
        .toArray()
    return {
        edges,
        pageInfo: {
            startCursor: edges[0]?.cursor,
            endCursor: last(edges)?.cursor,
            hasPreviousPage: Boolean(after), // The presence of an "after" cursor MUST mean there is at least one item BEFORE this page
            hasNextPage: last(result) !== last(edges)?.node,
        },
    }
}

export const createLoaders = ({ db, repoRoot }: { db: Client; repoRoot: string }): Loaders => {
    var loaders: Loaders = {
        codeSmell: {
            byId: new DataLoader<CodeSmell['id'], CodeSmell>(async ids => {
                const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
                    select code_smells.*
                    from unnest(${ids}::uuid[]) with ordinality as input_id
                    left join code_smells on input_id = code_smells.id
                    order by input_id.ordinality
                `)
                return result.rows.map((row, i) => {
                    const spec: CodeSmellSpec = { codeSmell: ids[i] }
                    if (!row.id) {
                        return new UnknownCodeSmellError(spec)
                    }
                    loaders.codeSmell.byOrdinal.prime(row, row)
                    return row
                })
            }),

            byOrdinal: new DataLoader<CodeSmellLifespanSpec & Pick<CodeSmell, 'ordinal'>, CodeSmell>(
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ lifespan, ordinal }, ordinality) => ({
                            ordinality,
                            lifespan,
                            ordinal,
                        }))
                    )
                    const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
                        select code_smells.*
                        from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "lifespan" uuid, "ordinal" int)
                        left join code_smells on code_smells.lifespan = input.lifespan
                        and code_smells.ordinal = input."ordinal"
                        order by input_id.ordinality
                    `)
                    return result.rows.map((row, i) => {
                        const spec = specs[i]
                        if (!row.id) {
                            return new UnknownCodeSmellError(spec)
                        }
                        loaders.codeSmell.byId.prime(row.id, row)
                        return row
                    })
                },
                { cacheKeyFn: ({ lifespan, ordinal }) => `${lifespan}#${ordinal}` }
            ),

            forCommit: new DataLoader<
                RepoSpec & CommitSpec & ForwardConnectionArguments,
                Connection<CodeSmell>
            >(
                logDuration('loaders.codeSmell.forCommit', async specs => {
                    const input = JSON.stringify(
                        specs.map(({ repository, commit, first, after }, index) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CodeSmell>(after, new Set(['id']))) || undefined
                            return { index, repository, commit, first, after: cursor?.value }
                        })
                    )
                    const result = await db.query<{
                        codeSmells: [null] | (CodeSmell & { lifespanObject: CodeSmellLifespan })[]
                    }>(sql`
                        select input."index", array_agg(row_to_json(c)) as "codeSmells"
                        from jsonb_to_recordset(${input}::jsonb) as input("index" int, "commit" text, "repository" text, "first" int, "after" uuid)
                        left join lateral (
                            select code_smells.*, row_to_json(code_smell_lifespans) as "lifespanObject"
                            from code_smells
                            inner join code_smell_lifespans on code_smells.lifespan = code_smell_lifespans.id
                            -- required filters:
                            where input.repository = code_smell_lifespans.repository and input.commit = code_smells.commit
                            -- pagination:
                            and (input.after is null or code_smells.id >= input.after) -- include one before to know whether there is a previous page
                            order by id asc
                            limit input.first + 1 -- query one more to know whether there is a next page
                        ) c on true
                        group by input."index"
                        order by input."index"
                    `)
                    assert.equal(result.rows.length, specs.length, 'Expected length to be the same')
                    return result.rows.map(
                        ({ codeSmells }, i): Connection<CodeSmell> => {
                            const spec = specs[i]
                            if (isNullArray(codeSmells)) {
                                codeSmells = []
                            }
                            for (const codeSmell of codeSmells) {
                                assert.equal(
                                    codeSmell.lifespanObject.repository,
                                    spec.repository,
                                    'Expected repository to equal input spec'
                                )
                                assert.equal(codeSmell.commit, spec.commit, 'Expected commit to equal input')
                                loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
                                loaders.codeSmell.byOrdinal.prime(codeSmell, codeSmell)
                                loaders.codeSmellLifespan.byId.prime(
                                    codeSmell.lifespan,
                                    codeSmell.lifespanObject
                                )
                            }
                            return connectionFromOverfetchedResult(codeSmells, spec, 'id')
                        }
                    )
                }),
                { cacheKeyFn: args => repoAtCommitCacheKeyFn(args) + connectionArgsKeyFn(args) }
            ),

            forLifespan: new DataLoader<
                CodeSmellLifespanSpec & ForwardConnectionArguments,
                Connection<CodeSmell>
            >(
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ lifespan, first, after }, index) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CodeSmellLifespan>(after, new Set(['id']))) || undefined
                            return { lifespan, index, first, after: cursor?.value }
                        })
                    )
                    const result = await db.query<{
                        instances: CodeSmell[] | [null]
                    }>(sql`
                        select array_agg(row_to_json(c) order by c."ordinal") as instances
                        from jsonb_to_recordset(${input}::jsonb) as input("index" int, "lifespan" uuid, "first" int, "after" uuid)
                        left join lateral (
                            select code_smells.*
                            from code_smells
                            where input.lifespan = code_smells.lifespan
                            and (input.after is null or code_smells.id >= input.after)
                            order by id
                            limit input.first + 1
                        ) c on true
                        group by input."index"
                        order by input."index"
                    `)
                    return result.rows.map(({ instances }, i) => {
                        const spec = specs[i]
                        if (isNullArray(instances)) {
                            instances = []
                        }
                        for (const codeSmell of instances) {
                            loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
                        }
                        return connectionFromOverfetchedResult(instances, spec, 'id')
                    })
                },
                { cacheKeyFn: args => args.lifespan + connectionArgsKeyFn(args) }
            ),
        },

        codeSmellLifespan: {
            byId: new DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan>(
                logDuration('loaders.codeSmellLifespan.byId', async ids => {
                    const result = await db.query<CodeSmellLifespan | NullFields<CodeSmellLifespan>>(sql`
                        select *
                        from unnest(${ids}::uuid[]) with ordinality as input_id
                        left join code_smells_lifespans on input_id = code_smell_lifespans.id
                        order by input_id.ordinality
                    `)
                    return result.rows.map((row, i) => {
                        const spec: CodeSmellLifespanSpec = { lifespan: ids[i] }
                        if (!row.id) {
                            return new UnknownCodeSmellLifespanError(spec)
                        }
                        return row
                    })
                })
            ),

            forRepository: new DataLoader(
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ repository, kind, first, after }, ordinality) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CodeSmellLifespan>(after, new Set(['id']))) || undefined
                            return { ordinality, repository, kind, first, after: cursor?.value }
                        })
                    )
                    const result = await db.query<{
                        lifespans: [null] | CodeSmellLifespan[]
                    }>(sql`
                        select array_agg(row_to_json(l)) as "lifespans"
                        from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "repository" text, "kind" text, "first" int, "after" uuid)
                        left join lateral (
                            select code_smell_lifespans.*
                            from code_smell_lifespans
                            where code_smell_lifespans.repository = input.repository
                            and (input.kind is null or code_smell_lifespans.kind = input.kind)
                            -- pagination:
                            and (input.after is null or code_smell_lifespans.id >= input.after) -- include one before to know whether there is a previous page
                            order by id asc
                            limit input.first + 1 -- query one more to know whether there is a next page
                        ) l on true
                        group by input.ordinality
                        order by input.ordinality
                    `)
                    return result.rows.map(({ lifespans }, i) => {
                        const spec = specs[i]
                        if (isNullArray(lifespans)) {
                            lifespans = []
                        }
                        for (const lifespan of lifespans) {
                            loaders.codeSmellLifespan.byId.prime(lifespan.id, lifespan)
                        }
                        return connectionFromOverfetchedResult(lifespans, spec, 'id')
                    })
                },
                {
                    cacheKeyFn: args =>
                        args.repository + (args.kind ? '?kind=' + args.kind : '') + connectionArgsKeyFn(args),
                }
            ),
        },

        files: new DataLoader<RepoSpec & CommitSpec, File[]>(
            logDuration('loaders.files', commits =>
                mapPromise(
                    commits,
                    ({ repository, commit }) =>
                        git.listFiles({ repository, commit, repoRoot }).catch(err => asError(err)),
                    { concurrency: 100 }
                )
            ),
            { cacheKeyFn: repoAtCommitCacheKeyFn }
        ),

        fileContent: new DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>(
            specs =>
                Promise.all(
                    specs.map(({ repository, commit, file }) =>
                        git.getFileContent({ repository, commit, repoRoot, file }).catch(err => asError(err))
                    )
                ),
            {
                cacheKeyFn: ({ file, ...spec }: RepoSpec & CommitSpec & FileSpec) =>
                    repoAtCommitCacheKeyFn(spec) + `#${file}`,
            }
        ),

        commit: {
            bySha: new DataLoader<RepoSpec & CommitSpec, Commit>(
                async commitSpecs => {
                    const byRepo = groupBy(commitSpecs, commit => commit.repository)
                    const commitsByRepo = new Map(
                        await Promise.all(
                            Object.entries(byRepo).map(
                                async ([repository, commits]) =>
                                    [
                                        repository,
                                        await git
                                            .getCommits({
                                                repoRoot,
                                                repository,
                                                commitShas: commits.map(c => c.commit),
                                            })
                                            .catch(err => asError(err)),
                                    ] as const
                            )
                        )
                    )
                    return commitSpecs.map(spec => {
                        const repoCommits = commitsByRepo.get(spec.repository)
                        if (repoCommits instanceof Error) {
                            return repoCommits
                        }
                        const commit = repoCommits?.get(spec.commit)
                        if (!commit) {
                            return new UnknownCommitError(spec)
                        }
                        return commit
                    })
                },
                { cacheKeyFn: repoAtCommitCacheKeyFn }
            ),

            forRepository: new DataLoader(
                logDuration('loaders.commit.forRepository', async specs =>
                    Promise.all(
                        specs.map(async ({ repository, first, after, grep }) => {
                            try {
                                const cursor =
                                    (after && parseCursor<Commit>(after, new Set(['sha']))) || undefined
                                const commits = await git
                                    .log({ repository, commit: cursor?.value, grep, repoRoot })
                                    .tap((commit: Commit) =>
                                        loaders.commit.bySha.prime({ repository, commit: commit.sha }, commit)
                                    )
                                    .take(typeof first === 'number' ? first + 1 : Infinity)
                                    .toArray()
                                return connectionFromOverfetchedResult<Commit>(
                                    commits,
                                    { first, after },
                                    'sha'
                                )
                            } catch (err) {
                                return asError(err)
                            }
                        })
                    )
                ),
                { cacheKeyFn: objectHash }
            ),
        },
    }

    return loaders
}
