import { Client } from 'pg'
import DataLoader from 'dataloader'
import sql from 'sql-template-strings'
import { listFiles, Commit, getCommits, getFileContent } from './git'
import { groupBy, last } from 'lodash'
import { CodeSmell, UUID, SHA, RepoSpec, CommitSpec, FileSpec, Location, File } from './models'
import { NullFields, base64encode, parseCursor, isNullArray } from './util'
import assert from 'assert'
import { Connection, Edge, ConnectionArguments } from 'graphql-relay'
import { IterableX } from 'ix/iterable'

export interface Loaders {
    /** Loads a code smell by ID. */
    codeSmell: DataLoader<UUID, CodeSmell | null>

    codeSmellSuccessor: DataLoader<UUID, CodeSmell | null>

    /** Loads the first occurences of code smells in a given repository. */
    codeSmellStartersInRepository: DataLoader<string, CodeSmell[] | null>

    /** Loads the entire life span of a given ID of the first occurence of a code smell. */
    codeSmellLifespan: DataLoader<UUID, CodeSmell[] | null>

    /** Loads the first occurence of any given code smell */
    codeSmellStarter: DataLoader<UUID, CodeSmell | null>

    codeSmellsByCommit: DataLoader<RepoSpec & CommitSpec & ConnectionArguments, Connection<CodeSmell>>

    files: DataLoader<RepoSpec & CommitSpec, File[]>
    fileContent: DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>

    commit: DataLoader<RepoSpec & CommitSpec, Commit | null>
}

const repoAtCommitCacheKeyFn = ({ repository, commit }: RepoSpec & CommitSpec) => `${repository}@${commit}`
const connectionArgsKeyFn = ({ first, after }: ConnectionArguments) => `*${after}+${first}`

/**
 * Creates a connection from a DB result page that was fetched with one more
 * item before and after than requested (if possible), which will be stripped
 * and used to determine pagination info.
 *
 * @param result The result array from the DB with one more item at the
 * beginning and end.
 * @param args The pagination options that were given.
 * @param cursorKey The key that was used to order the result and is used to determine the cursor.
 */
const connectionFromOverfetchedResult = <T extends object>(
    result: T[],
    { first, after }: ConnectionArguments,
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
    const codeSmellByIdLoader = new DataLoader<UUID, CodeSmell | null>(async ids => {
        const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
            select *
            from unnest(${ids}::uuid[]) with ordinality as input_id
            left join code_smells on input_id = code_smells.id
            order by input_id.ordinality
        `)
        return result.rows.map(row => (row.id ? row : null))
    })

    const codeSmellSuccessorLoader = new DataLoader<UUID, CodeSmell | null>(async ids => {
        const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
            select *
            from unnest(${ids}::uuid[]) with ordinality as input_id
            left join code_smells on input_id = code_smells.predecessor
            order by input_id.ordinality
        `)
        return result.rows.map((row, i) => {
            const codeSmell = row.id ? row : null
            codeSmellByIdLoader.prime(ids[i], codeSmell)
            return codeSmell
        })
    })

    const codeSmellsByCommitLoader = new DataLoader<
        RepoSpec & CommitSpec & ConnectionArguments,
        Connection<CodeSmell>
    >(
        async specs => {
            const input = JSON.stringify(
                specs.map(({ repository, commit, first, after }, ordinality) => {
                    assert(!first || first >= 0, 'Parameter first must be positive')
                    const cursor = (after && parseCursor<CodeSmell>(after, new Set(['id']))) || undefined
                    return { ordinality, repository, commit, first, afterId: cursor && cursor.value }
                })
            )
            const result = await db.query<{
                codeSmells: [null] | CodeSmell[]
            }>(sql`
                select input.ordinality, array_agg(row_to_json(c)) as "codeSmells"
                from jsonb_to_recordset(${input}::jsonb)
                as input("ordinality" int, "commit" text, "repository" text, "first" int, "after" uuid)
                join lateral (
                    select code_smells.*
                    from code_smells
                    -- required filters:
                    where input.repository = code_smells.repository and input.commit = code_smells.commit
                    -- pagination:
                    and (input.after is null or code_smells.id >= input.after) -- include one before to know whether there is a previous page
                    order by id asc
                    limit input.first + 1 -- query one more to know whether there is a next page
                ) c on true
                group by input.ordinality
                order by input.ordinality
            `)
            assert.equal(result.rows.length, specs.length)
            return result.rows.map(
                ({ codeSmells }, i): Connection<CodeSmell> => {
                    const spec = specs[i]
                    if (isNullArray(codeSmells)) {
                        codeSmells = []
                    }
                    for (const codeSmell of codeSmells) {
                        assert.equal(codeSmell.repository, spec.repository)
                        assert.equal(codeSmell.commit, spec.commit)
                        codeSmellByIdLoader.prime(codeSmell.id, codeSmell)
                    }
                    return connectionFromOverfetchedResult(codeSmells, spec, 'id')
                }
            )
        },
        { cacheKeyFn: args => repoAtCommitCacheKeyFn(args) + connectionArgsKeyFn(args) }
    )

    const codeSmellStarterInRepositoryLoader = new DataLoader<string, CodeSmell[] | null>(
        async repositories => {
            const result = await db.query<{
                codeSmells: [null] | CodeSmell[]
            }>(sql`
                select array_agg(row_to_json(code_smells)) as "codeSmells"
                from unnest(${repositories}::text[]) with ordinality as input_repository
                left join code_smells on code_smells.repository = input_repository
                where predecessor is null
                group by input_repository.ordinality
                order by input_repository.ordinality
            `)
            return result.rows.map((row, i) => {
                if (isNullArray(row.codeSmells)) {
                    return []
                }
                for (const codeSmell of row.codeSmells) {
                    assert.strictEqual(codeSmell.repository, repositories[i])
                    codeSmellByIdLoader.prime(codeSmell.id, codeSmell)
                }
                return row.codeSmells
            })
        }
    )

    const codeSmellLifespanLoader = new DataLoader<string, CodeSmell[] | null>(
        async (starterCodeSmellIds: UUID[]): Promise<(CodeSmell[] | null)[]> => {
            const result = await db.query<{
                input: UUID
                lifespan:
                    | {
                          id: UUID
                          kind: string
                          predecessor: string
                          message: string
                          commit: SHA
                          repository: string
                          locations: Location[]
                      }[]
                    | [null]
            }>(sql`
                with recursive successors as (
                    select id, kind, predecessor, "message", "commit", "repository", "locations", id as starter, 0 as lifespan_index
                    from code_smells
                    where id = any(${starterCodeSmellIds}::uuid[]) and predecessor is null
                    union all
                    select c.id, c.kind, c.predecessor, c."message", c."commit", c.repository, c.locations, s.starter, s.lifespan_index + 1 as lifespan_index
                    from code_smells c
                    join successors s on s.id = c.predecessor
                )
                select array_agg(row_to_json(successors) order by lifespan_index) as lifespan, input.input, input.ordinality
                from unnest(${starterCodeSmellIds}::uuid[]) with ordinality as input
                left join successors on input.input = successors.starter
                group by input.ordinality, input.input
                order by input.ordinality
            `)
            return result.rows.map((row, i) => {
                if (isNullArray(row.lifespan)) {
                    return null
                }
                assert.strictEqual(row.input, starterCodeSmellIds[i])
                assert.strictEqual(row.lifespan[0].id, starterCodeSmellIds[i])
                assert.strictEqual(row.lifespan[0].predecessor, null)
                for (const [i, codeSmell] of row.lifespan.entries()) {
                    if (i >= 1) {
                        assert.strictEqual(codeSmell.predecessor, row.lifespan[i - 1].id)
                    }
                    codeSmellByIdLoader.prime(codeSmell.id, codeSmell)
                    codeSmellSuccessorLoader.prime(codeSmell.id, row.lifespan[i + 1] || null)
                    codeSmellStarterLoader.prime(codeSmell.id, row.lifespan[0])
                }
                return row.lifespan
            })
        }
    )
    const codeSmellStarterLoader = new DataLoader<UUID, CodeSmell | null>(
        async (codeSmellIds: UUID[]): Promise<(CodeSmell | null)[]> => {
            const result = await db.query<CodeSmell | NullFields<CodeSmell>>(sql`
                with recursive predecessors as (
                    select id, kind, predecessor, "message", "commit", "repository", "locations", id as input
                    from code_smells
                    where id = any(${codeSmellIds}::uuid[])
                    union all
                    select c.id, c.kind, c.predecessor, c."message", c."commit", c.repository, c.locations, s.input
                    from code_smells c
                    join predecessors p on p.predecessor = c.id
                )
                select id, kind, predecessor, "message", "commit", repository, locations
                from unnest(${codeSmellIds}::uuid[]) with ordinality as input
                left join predecessors on input.input = predecessors.input and predecessors.predecessor is null
                group by input.ordinality
                order by input.ordinality
            `)
            assert.strictEqual(result.rows.length, codeSmellIds.length)
            return result.rows.map((row, i) => {
                if (!row.id) {
                    return null
                }
                assert.strictEqual(row.id, codeSmellIds[i])
                codeSmellByIdLoader.prime(row.id, row)
                return row
            })
        }
    )

    const filesLoader = new DataLoader<RepoSpec & CommitSpec, File[]>(
        async commits => {
            return await Promise.all(
                commits.map(({ repository, commit }) => listFiles({ repository, commit, repoRoot }))
            )
        },
        { cacheKeyFn: repoAtCommitCacheKeyFn }
    )

    const fileContentsLoader = new DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer>(
        async specs => {
            return await Promise.all(
                specs.map(({ repository, commit, file }) =>
                    getFileContent({ repository, commit, repoRoot, file })
                )
            )
        },
        {
            cacheKeyFn: ({ file, ...spec }: RepoSpec & CommitSpec & FileSpec) =>
                repoAtCommitCacheKeyFn(spec) + `#${file}`,
        }
    )

    const commitLoader = new DataLoader<RepoSpec & CommitSpec, Commit | null>(
        async commitSpecs => {
            const byRepo = groupBy(commitSpecs, commit => commit.repository)
            const commits = new Map(
                await Promise.all(
                    Object.entries(byRepo).map(
                        async ([repository, commits]) =>
                            [
                                repository,
                                await getCommits({
                                    repoRoot,
                                    repository,
                                    commitShas: commits.map(c => c.commit),
                                }),
                            ] as const
                    )
                )
            )
            return commitSpecs.map(({ repository, commit }) => {
                const forRepo = commits.get(repository)
                return (forRepo && forRepo.get(commit)) || null
            })
        },
        { cacheKeyFn: repoAtCommitCacheKeyFn }
    )

    return {
        codeSmell: codeSmellByIdLoader,
        codeSmellSuccessor: codeSmellSuccessorLoader,
        codeSmellStartersInRepository: codeSmellStarterInRepositoryLoader,
        codeSmellLifespan: codeSmellLifespanLoader,
        codeSmellStarter: codeSmellStarterLoader,
        codeSmellsByCommit: codeSmellsByCommitLoader,
        commit: commitLoader,
        files: filesLoader,
        fileContent: fileContentsLoader,
    }
}
