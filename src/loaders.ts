import { Client } from 'pg'
import DataLoader from 'dataloader'
import sql from 'sql-template-strings'
import * as git from './git'
import { groupBy, last } from 'lodash'
import {
    CodeSmell,
    UUID,
    RepoSpec,
    CommitSpec,
    FileSpec,
    File,
    CodeSmellLifespan,
    CodeSmellLifespanSpec,
    Commit,
} from './models'
import { NullFields, base64encode, parseCursor, isNullArray } from './util'
import assert from 'assert'
import { Connection, Edge, ConnectionArguments } from 'graphql-relay'
import { IterableX } from 'ix/iterable'

export type ForwardConnectionArguments = Pick<ConnectionArguments, 'first' | 'after'>

export interface Loaders {
    /** Loads a code smell by ID. */
    codeSmell: DataLoader<CodeSmell['id'], CodeSmell | null>

    /** Loads a code smell lifespan by ID. */
    codeSmellLifespanById: DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan | null>

    codeSmellByLifespanIndex: DataLoader<
        CodeSmellLifespanSpec & Pick<CodeSmell, 'lifespanIndex'>,
        CodeSmell | null
    >

    /** Loads the code smell lifespans in a given repository. */
    codeSmellLifespans: DataLoader<RepoSpec & ForwardConnectionArguments, Connection<CodeSmellLifespan>>

    /** Loads the entire life span of a given lifespan ID. */
    codeSmellLifespanInstances: DataLoader<
        CodeSmellLifespanSpec & ForwardConnectionArguments,
        Connection<CodeSmell>
    >

    /** Loads the lifespan of any given code smell */
    codeSmellLifespan: DataLoader<CodeSmell['id'], CodeSmellLifespan | null>

    codeSmellsByCommit: DataLoader<RepoSpec & CommitSpec & ForwardConnectionArguments, Connection<CodeSmell>>

    files: DataLoader<RepoSpec & CommitSpec, File[]>
    fileContent: DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>

    commit: DataLoader<RepoSpec & CommitSpec, Commit | null>

    /** Loads the existing commit SHAs in a repository */
    commits: DataLoader<RepoSpec & ForwardConnectionArguments, Connection<Commit>>
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

export const createLoaders = ({ db, repoRoot }: { db: Client; repoRoot: string }): Loaders => {
    var loaders: Loaders = {
        codeSmell: new DataLoader<UUID, CodeSmell | null>(async ids => {
            const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
                select *
                from unnest(${ids}::uuid[]) with ordinality as input_id
                left join code_smells on input_id = code_smells.id
                order by input_id.ordinality
            `)
            return result.rows.map(row => (row.id ? row : null))
        }),

        codeSmellLifespanById: new DataLoader<UUID, CodeSmellLifespan | null>(async ids => {
            const result = await db.query<CodeSmellLifespan | NullFields<CodeSmellLifespan>>(sql`
                select *
                from unnest(${ids}::uuid[]) with ordinality as input_id
                left join code_smells_lifespans on input_id = code_smell_lifespans.id
                order by input_id.ordinality
            `)
            return result.rows.map(row => (row.id ? row : null))
        }),

        codeSmellByLifespanIndex: new DataLoader<
            { lifespan: CodeSmellLifespan['id']; lifespanIndex: number },
            CodeSmell | null
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
                    select *
                    from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "lifespan" uuid, "lifespanIndex" int)
                    left join code_smells on code_smells.lifespan = input.lifespan
                    and code_smells.lifespan_index = input."lifespanIndex"
                    order by input_id.ordinality
                `)
                return result.rows.map((row, i) => {
                    const codeSmell = row.id ? row : null
                    loaders.codeSmell.prime(specs[i].lifespan, codeSmell)
                    return codeSmell
                })
            },
            { cacheKeyFn: ({ lifespan, lifespanIndex }) => `${lifespan}#${lifespanIndex}` }
        ),

        codeSmellsByCommit: new DataLoader<
            RepoSpec & CommitSpec & ForwardConnectionArguments,
            Connection<CodeSmell>
        >(
            async specs => {
                const input = JSON.stringify(
                    specs.map(({ repository, commit, first, after }, ordinality) => {
                        assert(!first || first >= 0, 'Parameter first must be positive')
                        const cursor = (after && parseCursor<CodeSmell>(after, new Set(['id']))) || undefined
                        return { ordinality, repository, commit, first, after: cursor?.value }
                    })
                )
                const result = await db.query<{
                    codeSmells: [null] | (CodeSmell & { lifespan: CodeSmellLifespan })[]
                }>(sql`
                    select input.ordinality, array_agg(row_to_json(c)) as "codeSmells"
                    from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "commit" text, "repository" text, "first" int, "after" uuid)
                    join lateral (
                        select code_smells.*, row_to_json(code_smell_lifespans) as "lifespan"
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
                            loaders.codeSmell.prime(codeSmell.id, codeSmell)
                            loaders.codeSmellLifespanById.prime(codeSmell.lifespan.id, codeSmell.lifespan)
                        }
                        return connectionFromOverfetchedResult(codeSmells, spec, 'id')
                    }
                )
            },
            { cacheKeyFn: args => repoAtCommitCacheKeyFn(args) + connectionArgsKeyFn(args) }
        ),

        codeSmellLifespans: new DataLoader<
            RepoSpec & ForwardConnectionArguments,
            Connection<CodeSmellLifespan>
        >(
            async specs => {
                const input = JSON.stringify(
                    specs.map(({ repository, first, after }, ordinality) => {
                        assert(!first || first >= 0, 'Parameter first must be positive')
                        const cursor =
                            (after && parseCursor<CodeSmellLifespan>(after, new Set(['id']))) || undefined
                        return { repository, ordinality, first, after: cursor?.value }
                    })
                )
                const result = await db.query<{
                    lifespans: [null] | CodeSmellLifespan[]
                }>(sql`
                    select array_agg(row_to_json(l)) as "lifespans"
                    from jsonb_to_recordset(${input}::jsonb) as input("ordinality" int, "repository" text, "first" int, "after" uuid)
                    join lateral (
                        select code_smell_lifespans.*
                        from code_smell_lifespans
                        where code_smell_lifespans.repository = input.repository
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
                        loaders.codeSmellLifespanById.prime(lifespan.id, lifespan)
                    }
                    return connectionFromOverfetchedResult(lifespans, spec, 'id')
                })
            },
            { cacheKeyFn: args => args.repository + connectionArgsKeyFn(args) }
        ),

        codeSmellLifespanInstances: new DataLoader<
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
                        select code_smells.*
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
                        loaders.codeSmell.prime(codeSmell.id, codeSmell)
                    }
                    return connectionFromOverfetchedResult(instances, spec, 'id')
                })
            },
            { cacheKeyFn: args => args.lifespan + connectionArgsKeyFn(args) }
        ),

        codeSmellLifespan: new DataLoader<CodeSmell['id'], CodeSmellLifespan | null>(async codeSmellIds => {
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
            return result.rows.map(row => {
                if (!row.id) {
                    return null
                }
                loaders.codeSmellLifespanById.prime(row.id, row)
                return row
            })
        }),

        files: new DataLoader<RepoSpec & CommitSpec, File[]>(
            async commits => {
                return await Promise.all(
                    commits.map(({ repository, commit }) => git.listFiles({ repository, commit, repoRoot }))
                )
            },
            { cacheKeyFn: repoAtCommitCacheKeyFn }
        ),

        fileContent: new DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>(
            async specs => {
                return await Promise.all(
                    specs.map(({ repository, commit, file }) =>
                        git.getFileContent({ repository, commit, repoRoot, file })
                    )
                )
            },
            {
                cacheKeyFn: ({ file, ...spec }: RepoSpec & CommitSpec & FileSpec) =>
                    repoAtCommitCacheKeyFn(spec) + `#${file}`,
            }
        ),

        commit: new DataLoader<RepoSpec & CommitSpec, Commit | null>(
            async commitSpecs => {
                const byRepo = groupBy(commitSpecs, commit => commit.repository)
                const commits = new Map(
                    await Promise.all(
                        Object.entries(byRepo).map(
                            async ([repository, commits]) =>
                                [
                                    repository,
                                    await git.getCommits({
                                        repoRoot,
                                        repository,
                                        commitShas: commits.map(c => c.commit),
                                    }),
                                ] as const
                        )
                    )
                )
                return commitSpecs.map(
                    ({ repository, commit }) => commits.get(repository)?.get(commit) || null
                )
            },
            { cacheKeyFn: repoAtCommitCacheKeyFn }
        ),

        commits: new DataLoader<RepoSpec & ForwardConnectionArguments, Connection<Commit>>(async specs => {
            return Promise.all(
                specs.map(async ({ repository, first, after }) => {
                    try {
                        const cursor = (after && parseCursor<Commit>(after, new Set(['sha']))) || undefined
                        const commits = await git
                            .log({ repository, commit: cursor?.value, repoRoot })
                            .tap((commit: Commit) =>
                                loaders.commit.prime({ repository, commit: commit.sha }, commit)
                            )
                            .take(typeof first === 'number' ? first + 1 : Infinity)
                            .toArray()
                        return connectionFromOverfetchedResult<Commit>(commits, { first, after }, 'sha')
                    } catch (err) {
                        return err
                    }
                })
            )
        }),
    }

    return loaders
}
