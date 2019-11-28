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
import { NullFields, base64encode, parseCursor, isNullArray, asError } from './util'
import assert from 'assert'
import { Connection, Edge, ConnectionArguments } from 'graphql-relay'
import { IterableX } from 'ix/iterable'
import { UnknownCodeSmellError, UnknownCommitError, UnknownCodeSmellLifespanError } from './errors'

export type ForwardConnectionArguments = Pick<ConnectionArguments, 'first' | 'after'>

export interface Loaders {
    codeSmell: {
        /** Loads a code smell by ID. */
        byId: DataLoader<CodeSmell['id'], CodeSmell>
        byLifespanIndex: DataLoader<CodeSmellLifespanSpec & Pick<CodeSmell, 'lifespanIndex'>, CodeSmell>
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
        /** Loads the lifespan of any given code smell */
        forCodeSmell: DataLoader<CodeSmell['id'], CodeSmellLifespan>
    }

    commit: {
        bySha: DataLoader<RepoSpec & CommitSpec, Commit>

        /** Loads the existing commit SHAs in a repository */
        forRepository: DataLoader<RepoSpec & ForwardConnectionArguments, Connection<Commit>>
    }

    files: DataLoader<RepoSpec & CommitSpec, File[]>
    fileContent: DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>
}

const repoAtCommitCacheKeyFn = ({ repository, commit }: RepoSpec & CommitSpec) => `${repository}@${commit}`
const connectionArgsKeyFn = ({ first, after }: ForwardConnectionArguments) => `*${after}+${first}`

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

export const createLoaders = ({ db, repoRoot }: { db: Client; repoRoot: string }) => {
    var loaders: Loaders = {
        codeSmell: {
            byId: new DataLoader<CodeSmell['id'], CodeSmell>(async ids => {
                const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
                    select code_smells.*, code_smells.lifespan_index as "lifespanIndex"
                    from unnest(${ids}::uuid[]) with ordinality as input_id
                    left join code_smells on input_id = code_smells.id
                    order by input_id.ordinality
                `)
                return result.rows.map((row, i) => {
                    const spec: CodeSmellSpec = { codeSmell: ids[i] }
                    if (!row.id) {
                        return new UnknownCodeSmellError(spec)
                    }
                    loaders.codeSmell.byLifespanIndex.prime(row, row)
                    return row
                })
            }),

            byLifespanIndex: new DataLoader<
                CodeSmellLifespanSpec & Pick<CodeSmell, 'lifespanIndex'>,
                CodeSmell
            >(
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ lifespan, lifespanIndex }, ordinality) => ({
                            ordinality,
                            lifespan,
                            lifespanIndex,
                        }))
                    )
                    const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
                        select code_smells.*, code_smells.lifespan_index as "lifespanIndex"
                        from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "lifespan" uuid, "lifespanIndex" int)
                        left join code_smells on code_smells.lifespan = input.lifespan
                        and code_smells.lifespan_index = input."lifespanIndex"
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
                { cacheKeyFn: ({ lifespan, lifespanIndex }) => `${lifespan}#${lifespanIndex}` }
            ),

            forCommit: new DataLoader<
                RepoSpec & CommitSpec & ForwardConnectionArguments,
                Connection<CodeSmell>
            >(
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ repository, commit, first, after }, ordinality) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CodeSmell>(after, new Set(['id']))) || undefined
                            return { ordinality, repository, commit, first, after: cursor?.value }
                        })
                    )
                    const result = await db.query<{
                        codeSmells: [null] | (CodeSmell & { lifespan: CodeSmellLifespan })[]
                    }>(sql`
                        select input.ordinality, array_agg(row_to_json(c)) as "codeSmells"
                        from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "commit" text, "repository" text, "first" int, "after" uuid)
                        join lateral (
                            select code_smells.*, code_smells.lifespan_index as "lifespanIndex", row_to_json(code_smell_lifespans) as "lifespan"
                            from code_smells
                            inner join code_smell_lifespans on code_smells.lifespan = code_smell_lifespans.id
                            -- required filters:
                            where input.repository = code_smell_lifespans.repository and input.commit = code_smells.commit
                            -- pagination:
                            and (input.after is null or code_smells.id >= input.after) -- include one before to know whether there is a previous page
                            order by id asc
                            limit input.first + 1 -- query one more to know whether there is a next page
                        ) c on true
                        group by input.ordinality
                        order by input.ordinality
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
                                    codeSmell.lifespan.repository,
                                    spec.repository,
                                    'Expected repository to equal input spec'
                                )
                                assert.equal(codeSmell.commit, spec.commit, 'Expected commit to equal input')
                                loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
                                loaders.codeSmell.byLifespanIndex.prime(codeSmell, codeSmell)
                                loaders.codeSmellLifespan.byId.prime(
                                    codeSmell.lifespan.id,
                                    codeSmell.lifespan
                                )
                            }
                            return connectionFromOverfetchedResult(codeSmells, spec, 'id')
                        }
                    )
                },
                { cacheKeyFn: args => repoAtCommitCacheKeyFn(args) + connectionArgsKeyFn(args) }
            ),

            forLifespan: new DataLoader<
                CodeSmellLifespanSpec & ForwardConnectionArguments,
                Connection<CodeSmell>
            >(
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ lifespan, first, after }, ordinality) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CodeSmellLifespan>(after, new Set(['id']))) || undefined
                            return { lifespan, ordinality, first, after: cursor?.value }
                        })
                    )
                    const result = await db.query<{
                        instances: CodeSmell[] | [null]
                    }>(sql`
                        select array_agg(row_to_json(c) order by lifespan_index) as instances
                        from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "lifespan" uuid, "first" int, "after" uuid)
                        join lateral (
                            select code_smells.*, code_smells.lifespan_index as "lifespanIndex"
                            from code_smells
                            where input.lifespan = code_smells.lifespan
                            and (input.after is null or code_smells.id >= input.after)
                            order by id
                            limit input.first + 1
                        ) c on true
                        group by input.ordinality
                        order by input.ordinality
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
            byId: new DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan>(async ids => {
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
            }),

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
                        join lateral (
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

            forCodeSmell: new DataLoader<CodeSmell['id'], CodeSmellLifespan>(async codeSmellIds => {
                const result = await db.query<CodeSmellLifespan | NullFields<CodeSmellLifespan>>(sql`
                    select code_smell_lifespans.*
                    from unnest(${codeSmellIds}::uuid[]) with ordinality as input
                    left join code_smells
                    on input.input = code_smells.id
                    left join code_smell_lifespans
                    on code_smells.lifespan = code_smell_lifespans.id
                    order by input.ordinality
                `)
                assert.strictEqual(result.rows.length, codeSmellIds.length)
                return result.rows.map((row, i) => {
                    const spec: CodeSmellSpec = { codeSmell: codeSmellIds[i] }
                    if (!row.id) {
                        return new UnknownCodeSmellError(spec)
                    }
                    loaders.codeSmellLifespan.byId.prime(row.id, row)
                    return row
                })
            }),
        },

        files: new DataLoader<RepoSpec & CommitSpec, File[]>(
            async commits => {
                return await Promise.all(
                    commits.map(({ repository, commit }) =>
                        git.listFiles({ repository, commit, repoRoot }).catch(err => asError(err))
                    )
                )
            },
            { cacheKeyFn: repoAtCommitCacheKeyFn }
        ),

        fileContent: new DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>(
            async specs => {
                return await Promise.all(
                    specs.map(({ repository, commit, file }) =>
                        git.getFileContent({ repository, commit, repoRoot, file }).catch(err => asError(err))
                    )
                )
            },
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

            forRepository: new DataLoader<RepoSpec & ForwardConnectionArguments, Connection<Commit>>(
                async specs => {
                    return Promise.all(
                        specs.map(async ({ repository, first, after }) => {
                            try {
                                const cursor =
                                    (after && parseCursor<Commit>(after, new Set(['sha']))) || undefined
                                const commits = await git
                                    .log({ repository, commit: cursor?.value, repoRoot })
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
                }
            ),
        },
    }

    return loaders
}
