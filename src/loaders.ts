import DataLoader from 'dataloader'
import sql from 'sql-template-strings'
import * as git from './git'
import { last } from 'lodash'
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
    CombinedFileDifference,
    RepoRootSpec,
    Analysis,
    AnalysisSpec,
} from './models'
import {
    NullFields,
    base64encode,
    parseCursor,
    isNullArray,
    asError,
    DBContext,
    CursorKey,
    withDBConnection,
} from './util'
import assert from 'assert'
import { Connection, Edge, ConnectionArguments, cursorToOffset, offsetToCursor } from 'graphql-relay'
import { IterableX } from 'ix/iterable'
import {
    UnknownCodeSmellError,
    UnknownCommitError,
    UnknownCodeSmellLifespanError,
    UnknownAnalysisError,
} from './errors'
import objectHash from 'object-hash'
import mapPromise from 'p-map'
import { trace, ParentSpanContext } from './tracing'

export type ForwardConnectionArguments = Pick<ConnectionArguments, 'first' | 'after'>

/** Optional filter for the kind of a code smell. */
export interface KindFilter {
    /** Optional filter for the kind of a code smell. */
    kind: string | null
}

export interface DirectoryFilter {
    directory: string | null
}

export interface PathPatternFilter {
    pathPattern: string | null
}

export interface Loaders {
    analysis: {
        all: DataLoader<ForwardConnectionArguments, Connection<Analysis>, string>
        byId: DataLoader<Analysis['id'], Analysis>
        byName: DataLoader<Analysis['name'], Analysis>
    }
    codeSmell: {
        /** Loads a code smell by ID. */
        byId: DataLoader<CodeSmell['id'], CodeSmell>
        byOrdinal: DataLoader<CodeSmellLifespanSpec & Pick<CodeSmell, 'ordinal'>, CodeSmell, string>
        /** Loads the entire life span of a given lifespan ID. */
        forLifespan: DataLoader<
            CodeSmellLifespanSpec & ForwardConnectionArguments,
            Connection<CodeSmell>,
            string
        >
        many: DataLoader<
            Partial<RepoSpec> &
                Partial<CommitSpec> &
                Partial<AnalysisSpec> &
                Partial<FileSpec> &
                KindFilter &
                PathPatternFilter &
                ForwardConnectionArguments,
            Connection<CodeSmell>,
            string
        >
    }
    codeSmellLifespan: {
        /** Loads a code smell lifespan by ID. */
        oneById: DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan>
        /** Loads the code smell lifespans for a given repository, analysis and/or kind. */
        many: DataLoader<
            Partial<RepoSpec> & Partial<AnalysisSpec> & KindFilter & ForwardConnectionArguments,
            Connection<CodeSmellLifespan>,
            string
        >
    }

    repository: {
        forAnalysis: DataLoader<AnalysisSpec & ForwardConnectionArguments, Connection<RepoSpec>, string>
    }

    commit: {
        byOid: DataLoader<RepoSpec & CommitSpec, Commit, string>

        /** Loads the existing commit OIDs in a repository */
        forRepository: DataLoader<
            RepoSpec & ForwardConnectionArguments & git.GitLogFilters,
            Connection<Commit>,
            string
        >

        /** Loads the commits (and their repos) that were analyzed in an analysis */
        forAnalysis: DataLoader<
            AnalysisSpec & ForwardConnectionArguments,
            Connection<RepoSpec & CommitSpec>,
            string
        >
    }

    files: DataLoader<RepoSpec & CommitSpec & DirectoryFilter, File[], string>
    combinedFileDifference: {
        forCommit: DataLoader<RepoSpec & CommitSpec, CombinedFileDifference[], string>
    }
    fileContent: DataLoader<RepoSpec & CommitSpec & FileSpec, Buffer, string>
}

const repoAtCommitCacheKeyFn = ({ repository, commit }: RepoSpec & CommitSpec): string =>
    `${repository}@${commit}`
const fileKeyFn = ({ file }: Partial<FileSpec>): string => (file ? `#${file}` : '')
const connectionArgsKeyFn = ({ first, after }: ForwardConnectionArguments): string => `*${after}+${first}`

export const makeCursorFromKey = <T extends object>(cursorKey: CursorKey<T>) => (node: T) =>
    base64encode(cursorKey.join(',') + ':' + cursorKey.map(k => node[k]).join(''))

/**
 * Creates a connection from a DB result page that was fetched with one more
 * item before and after than requested (if possible), which will be stripped
 * and used to determine pagination info.
 *
 * @param result The result array from the DB with one more item at the beginning and end.
 * @param args The pagination options that were given.
 * @param cursorKey The (potentially compound) key that was used to order the result and is used to determine the cursor.
 */
const connectionFromOverfetchedResult = <T extends object>(
    result: T[],
    { first, after }: ForwardConnectionArguments,
    cursorStrategy: CursorKey<T> | ((node: T, index: number) => string)
): Connection<T> => {
    const makeCursor =
        typeof cursorStrategy === 'function' ? cursorStrategy : makeCursorFromKey(cursorStrategy)
    const edges: Edge<T>[] = IterableX.from(result)
        .map((node, index) => ({
            node,
            get cursor() {
                return makeCursor(node, index)
            },
        }))
        .skip(after ? 1 : 0)
        .take(first ?? Infinity)
        .toArray()
    return {
        edges,
        get pageInfo() {
            return {
                startCursor: edges[0]?.cursor,
                endCursor: last(edges)?.cursor,
                hasPreviousPage: !!after, // The presence of an "after" cursor MUST mean there is at least one item BEFORE this page
                hasNextPage: last(result) !== last(edges)?.node,
            }
        },
    }
}

/**
 * Run `mapper` for every group of commits, grouped by repository.
 *
 * @returns The results grouped by repository.
 */
async function mapCommitRepoSpecsGroupedByRepo<R>(
    specs: readonly (CommitSpec & RepoSpec)[],
    mapper: (value: RepoSpec & { commits: IterableX<CommitSpec> }) => Promise<R>
): Promise<ReadonlyMap<RepoSpec['repository'], R | Error>> {
    const byRepo = IterableX.from(specs).groupBy(spec => spec.repository)
    const resultsByRepo = new Map(
        await mapPromise(
            byRepo,
            async commitsForRepo =>
                [
                    commitsForRepo.key,
                    await mapper({ repository: commitsForRepo.key, commits: commitsForRepo }).catch(err =>
                        asError(err)
                    ),
                ] as const
        )
    )
    return resultsByRepo
}

// Use a macrotask to schedule, not just a microtask
const batchScheduleFn = (callback: () => void) => setTimeout(callback, 100)

export const createLoaders = ({
    dbPool,
    span,
    repoRoot,
}: DBContext & ParentSpanContext & RepoRootSpec): Loaders => {
    var loaders: Loaders = {
        codeSmell: {
            byId: new DataLoader<CodeSmell['id'], CodeSmell>(
                ids =>
                    trace(span, 'loaders.codeSmell.byId', async span => {
                        const result = await dbPool.query<CodeSmell | NullFields<CodeSmell>>(sql`
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
                { batchScheduleFn }
            ),

            byOrdinal: new DataLoader<CodeSmellLifespanSpec & Pick<CodeSmell, 'ordinal'>, CodeSmell, string>(
                specs =>
                    trace(span, 'loaders.codeSmell.byOrdinal', async span => {
                        const input = JSON.stringify(
                            specs.map(({ lifespan, ordinal }, index) => ({ index, lifespan, ordinal }))
                        )
                        const result = await dbPool.query<CodeSmell | NullFields<CodeSmell>>(sql`
                            select code_smells.*
                            from jsonb_to_recordset(${input}::jsonb) as input("index" int, "lifespan" uuid, "ordinal" int)
                            left join code_smells on code_smells.lifespan = input.lifespan
                            and code_smells.ordinal = input."ordinal"
                            order by input."index"
                        `)
                        return result.rows.map((row, i) => {
                            const spec = specs[i]
                            if (!row.id) {
                                return new UnknownCodeSmellError(spec)
                            }
                            loaders.codeSmell.byId.prime(row.id, row)
                            return row
                        })
                    }),
                { batchScheduleFn, cacheKeyFn: ({ lifespan, ordinal }) => `${lifespan}#${ordinal}` }
            ),

            many: new DataLoader(
                specs =>
                    trace(span, 'loaders.codeSmell.many', async span => {
                        const queries = IterableX.from(specs)
                            .map(
                                ({ repository, commit, analysis, file, kind, pathPattern, first, after }) => {
                                    assert(!first || first >= 0, 'Parameter first must be positive')
                                    const cursor =
                                        (after && parseCursor<CodeSmell>(after, ['id'])) || undefined
                                    return {
                                        repository: repository || undefined,
                                        commit: commit || undefined,
                                        fileQuery: file ? [{ file }] : undefined,
                                        pathPattern: pathPattern || undefined,
                                        kind: kind || undefined,
                                        analysis: analysis || undefined,
                                        first,
                                        after: cursor?.value,
                                    }
                                }
                            )
                            // Group by query shape, defined by which filters are passed
                            .groupBy(
                                ({
                                    first,
                                    after,
                                    analysis,
                                    pathPattern,
                                    kind,
                                    fileQuery,
                                    commit,
                                    repository,
                                }) =>
                                    `${!!first}${!!after}${!!analysis}${!!pathPattern}${!!kind}${!!fileQuery}${!!commit}${!!repository}`
                            )
                            // Build query
                            .map(specGroup => {
                                const specArr = specGroup.toArray()
                                const firstSpec = specArr[0]
                                const query = sql`
                                    with input as materialized (
                                        select
                                            ordinality,
                                            nullif(spec->>'commit', '')::text as "commit",
                                            nullif(spec->>'repository', '')::text as "repository",
                                            nullif(spec->>'analysis', '')::uuid as "analysis",
                                            nullif(spec->'fileQuery', 'null')::jsonb as "file",
                                            nullif(spec->>'pathPattern', '')::text as "path",
                                            nullif(spec->>'kind', '')::text as "kind",
                                            nullif(spec->'first', 'null')::int as "first",
                                            nullif(spec->>'after', '')::uuid as "after"
                                        from rows from (unnest(${specArr}::jsonb[])) with ordinality as spec
                                    )
                                    select json_agg(c order by id) as "codeSmells"
                                    from input
                                    left join lateral (
                                        select "id", "message", "ordinal", "lifespan", "commit", "locations",
                                            jsonb_build_object('id', lifespan, 'repository', repository, 'kind', kind, 'analysis', analysis) as "lifespanObject"
                                        from code_smells_for_commit
                                        where true
                                `
                                if (firstSpec.repository) {
                                    query.append(
                                        sql` and code_smells_for_commit."repository" = input."repository" `
                                    )
                                }
                                if (firstSpec.analysis) {
                                    query.append(
                                        sql` and code_smells_for_commit."analysis" = input."analysis" `
                                    )
                                }
                                if (firstSpec.kind) {
                                    query.append(sql` and code_smells_for_commit."kind" = input."kind" `)
                                }
                                if (firstSpec.commit) {
                                    query.append(sql` and code_smells_for_commit."commit" = input."commit" `)
                                }
                                if (firstSpec.fileQuery) {
                                    query.append(
                                        sql` and code_smells_for_commit."locations" @> input."fileQuery" `
                                    )
                                }
                                if (firstSpec.pathPattern) {
                                    query.append(sql`
                                        and exists (
                                            select "file"
                                            from jsonb_to_recordset(code_smells_for_commit.locations) as locations("file" text)
                                            where "file" ~* input."pathPattern"
                                        )
                                    `)
                                }
                                if (firstSpec.after) {
                                    query.append(sql` and code_smells_for_commit."id" >= input."after" `)
                                }
                                if (typeof firstSpec.first === 'number') {
                                    query.append(sql` order by code_smells_for_commit.id asc `)
                                    // query one more to know whether there is a next page
                                    query.append(sql` limit input.first + 1 `)
                                }
                                query.append(sql`
                                    ) c on true
                                    group by input."ordinality"
                                    order by input."ordinality"
                                `)
                                return query
                            })

                        const results = await mapPromise(
                            queries,
                            async query => {
                                const results = await withDBConnection(dbPool, dbClient =>
                                    dbClient.query<{
                                        codeSmells:
                                            | [null]
                                            | (CodeSmell & {
                                                  lifespanObject: CodeSmellLifespan
                                              })[]
                                    }>(query)
                                )
                                return results.rows
                            },
                            { concurrency: 100 }
                        )

                        return IterableX.from(results)
                            .flatMap(rows => rows)
                            .map(({ codeSmells }, i) => {
                                const spec = specs[i]
                                if (isNullArray(codeSmells)) {
                                    codeSmells = []
                                }
                                for (const codeSmell of codeSmells) {
                                    if (spec.analysis) {
                                        assert.strictEqual(
                                            codeSmell.lifespanObject.analysis,
                                            spec.analysis,
                                            'Expected commit to equal input'
                                        )
                                    }
                                    if (spec.repository) {
                                        assert.strictEqual(
                                            codeSmell.lifespanObject.repository,
                                            spec.repository,
                                            'Expected repository to equal input'
                                        )
                                    }
                                    if (spec.commit) {
                                        assert.strictEqual(
                                            codeSmell.commit,
                                            spec.commit,
                                            'Expected commit to equal input'
                                        )
                                    }
                                    loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
                                    loaders.codeSmell.byOrdinal.prime(codeSmell, codeSmell)
                                    loaders.codeSmellLifespan.oneById.prime(
                                        codeSmell.lifespan,
                                        codeSmell.lifespanObject
                                    )
                                }
                                return connectionFromOverfetchedResult<CodeSmell>(codeSmells, spec, ['id'])
                            })
                            .toArray()
                    }),
                {
                    batchScheduleFn,
                    cacheKeyFn: ({ repository, commit, analysis, file, kind, first, after }) =>
                        objectHash({ repository, commit, analysis, file, kind, first, after }),
                }
            ),

            forLifespan: new DataLoader(
                specs =>
                    trace(span, 'loaders.codeSmell.forLifespan', async span => {
                        const input = JSON.stringify(
                            specs.map(({ lifespan, first, after }, index) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<CodeSmellLifespan>(after, ['id'])) || undefined
                                return { lifespan, index, first, after: cursor?.value }
                            })
                        )
                        const result = await dbPool.query<{
                            instances: CodeSmell[] | [null]
                        }>(sql`
                            select array_agg(to_jsonb(c) order by c."ordinal") as instances
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
                            return connectionFromOverfetchedResult(instances, spec, ['id'])
                        })
                    }),
                { batchScheduleFn, cacheKeyFn: args => args.lifespan + connectionArgsKeyFn(args) }
            ),
        },

        analysis: {
            all: new DataLoader(
                specs =>
                    trace(span, 'loaders.analysis.all', async span => {
                        const input = JSON.stringify(
                            specs.map(({ first, after }, index) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor = (after && parseCursor<Analysis>(after, ['name'])) || undefined
                                return { index, first, after: cursor?.value }
                            })
                        )
                        const result = await dbPool.query<{
                            analyses: [null] | Analysis[]
                        }>(sql`
                            select json_agg(a) as "analyses"
                            from jsonb_to_recordset(${input}::jsonb) as input("index" int, "first" int, "after" uuid)
                            left join lateral (
                                select analyses.*
                                from analyses
                                -- pagination:
                                where (input.after is null or analyses.id >= input.after) -- include one before to know whether there is a previous page
                                order by "name" asc
                                limit input.first + 1 -- query one more to know whether there is a next page
                            ) a on true
                            group by input."index"
                            order by input."index"
                        `)
                        return result.rows.map(({ analyses }, i) => {
                            const spec = specs[i]
                            if (isNullArray(analyses)) {
                                analyses = []
                            }
                            for (const analysis of analyses) {
                                loaders.analysis.byId.prime(analysis.id, analysis)
                                loaders.analysis.byName.prime(analysis.name, analysis)
                            }
                            return connectionFromOverfetchedResult(analyses, spec, ['name'])
                        })
                    }),
                { batchScheduleFn, cacheKeyFn: connectionArgsKeyFn }
            ),
            byId: new DataLoader<Analysis['id'], Analysis>(ids =>
                trace(span, 'loaders.analysis.byId', async span => {
                    const result = await dbPool.query<Analysis | NullFields<Analysis>>(sql`
                        select *
                        from unnest(${ids}::uuid[]) with ordinality as input_id
                        left join analyses on input_id = analyses.id
                        order by input_id.ordinality
                    `)
                    return result.rows.map((row, i) => {
                        if (!row.id) {
                            return new UnknownAnalysisError({ analysis: ids[i] })
                        }
                        return row
                    })
                })
            ),
            byName: new DataLoader<Analysis['name'], Analysis>(names =>
                trace(span, 'loaders.analysis.byName', async span => {
                    const result = await dbPool.query<Analysis | NullFields<Analysis>>(sql`
                        select *
                        from unnest(${names}::text[]) with ordinality as input
                        left join analyses on input = analyses.name
                        order by input.ordinality
                    `)
                    return result.rows.map((row, i) => {
                        if (!row.id) {
                            return new UnknownAnalysisError({ name: names[i] })
                        }
                        return row
                    })
                })
            ),
        },

        codeSmellLifespan: {
            oneById: new DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan>(ids =>
                trace(span, 'loaders.codeSmellLifespan.oneById', async span => {
                    const result = await dbPool.query<CodeSmellLifespan | NullFields<CodeSmellLifespan>>(sql`
                        select *
                        from unnest(${ids}::uuid[]) with ordinality as input_id
                        left join code_smell_lifespans on input_id = code_smell_lifespans.id
                        order by input_id.ordinality
                    `)
                    return result.rows.map((row, i) => {
                        if (!row.id) {
                            return new UnknownCodeSmellLifespanError({ lifespan: ids[i] })
                        }
                        return row
                    })
                })
            ),
            many: new DataLoader(
                specs =>
                    trace(span, 'loaders.codeSmellLifespan.many', async span => {
                        const queries = IterableX.from(specs)
                            .map(({ repository, analysis, kind, first, after }) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<CodeSmellLifespan>(after, ['id'])) || undefined
                                return {
                                    repository: repository || undefined,
                                    analysis: analysis || undefined,
                                    kind: kind || undefined,
                                    first,
                                    after: cursor?.value || undefined,
                                }
                            })
                            // Group by query shape, defined by which filters are passed
                            .groupBy(
                                ({ first, after, analysis, kind, repository }) =>
                                    `${!!first}${!!after}${!!analysis}${!!kind}${!!repository}`
                            )
                            // Build query
                            .map(specGroup => {
                                const specArr = specGroup.toArray()
                                const firstSpec = specArr[0]
                                const query = sql`
                                    with input as materialized (
                                        select
                                            ordinality,
                                            nullif(spec->>'repository', '')::text as "repository",
                                            nullif(spec->>'analysis', '')::uuid as "analysis",
                                            nullif(spec->>'kind', '')::text as "kind",
                                            nullif(spec->'first', 'null')::int as "first",
                                            nullif(spec->>'after', '')::uuid as "after"
                                        from rows from (unnest(${specArr}::jsonb[])) with ordinality as spec
                                    )
                                    select json_agg(l order by id) as "lifespans"
                                    from input
                                    left join lateral (
                                        select code_smell_lifespans.*
                                        from code_smell_lifespans
                                        where true
                                `
                                if (firstSpec.repository) {
                                    query.append(
                                        sql` and code_smell_lifespans.repository = input.repository `
                                    )
                                }
                                if (firstSpec.analysis) {
                                    query.append(sql` and code_smell_lifespans.analysis = input.analysis `)
                                }
                                if (firstSpec.kind) {
                                    query.append(sql` and code_smell_lifespans.kind = input.kind `)
                                }
                                if (firstSpec.after) {
                                    // include one before to know whether there is a previous page
                                    query.append(sql` and code_smell_lifespans.id >= input.after `)
                                }
                                if (typeof firstSpec.first === 'number') {
                                    query.append(sql` order by code_smell_lifespans.id asc `)
                                    // query one more to know whether there is a next page
                                    query.append(sql` limit input.first + 1 `)
                                }
                                query.append(sql`
                                    ) l on true
                                    group by input."ordinality"
                                    order by input."ordinality"
                                `)
                                return query
                            })

                        const results = await mapPromise(
                            queries,
                            async query => {
                                const result = await dbPool.query<{
                                    lifespans: [null] | CodeSmellLifespan[]
                                }>(query)
                                return result.rows
                            },
                            { concurrency: 100 }
                        )
                        return IterableX.from(results)
                            .flatMap(rows => rows)
                            .map(({ lifespans }, i) => {
                                const spec = specs[i]
                                if (isNullArray(lifespans)) {
                                    lifespans = []
                                }
                                for (const lifespan of lifespans) {
                                    loaders.codeSmellLifespan.oneById.prime(lifespan.id, lifespan)
                                }
                                return connectionFromOverfetchedResult(lifespans, spec, ['id'])
                            })
                            .toArray()
                    }),
                {
                    batchScheduleFn,
                    cacheKeyFn: ({ repository, analysis, kind, first, after }) =>
                        objectHash({ repository, analysis, kind, first, after }),
                }
            ),
        },

        files: new DataLoader(
            commits =>
                trace(span, 'loaders.files', span =>
                    mapPromise(
                        commits,
                        ({ repository, commit, directory }) =>
                            git
                                .listFiles({ repository, commit, repoRoot, directory })
                                .catch(err => asError(err)),
                        { concurrency: 100 }
                    )
                ),
            {
                batchScheduleFn,
                cacheKeyFn: ({ repository, commit, directory }) =>
                    objectHash({ repository, commit, directory }),
            }
        ),

        combinedFileDifference: {
            forCommit: new DataLoader<RepoSpec & CommitSpec, CombinedFileDifference[], string>(
                specs =>
                    trace(span, 'loaders.combinedFileDifference.forCommit', async span => {
                        const commitsByRepo = await mapCommitRepoSpecsGroupedByRepo(
                            specs,
                            ({ repository, commits }) =>
                                git
                                    .getCombinedCommitDifference({
                                        repoRoot,
                                        repository,
                                        commitOids: commits.map(c => c.commit),
                                    })
                                    .catch(err => asError(err))
                        )
                        return specs.map(spec => {
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
                    }),
                { batchScheduleFn, cacheKeyFn: repoAtCommitCacheKeyFn }
            ),
        },

        fileContent: new DataLoader(
            specs =>
                trace(span, 'loaders.fileContent', span =>
                    mapPromise(
                        specs,
                        ({ repository, commit, file }) =>
                            git
                                .getFileContent({ repository, commit, repoRoot, file })
                                .catch(err => asError(err)),
                        { concurrency: 100 }
                    )
                ),
            { batchScheduleFn, cacheKeyFn: spec => repoAtCommitCacheKeyFn(spec) + fileKeyFn(spec) }
        ),

        repository: {
            forAnalysis: new DataLoader(
                specs =>
                    trace(span, 'loaders.repository.forAnalysis', async span => {
                        const cursorKey: CursorKey<RepoSpec> = ['repository']
                        const input = JSON.stringify(
                            specs.map(({ analysis, first, after }, index) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<RepoSpec>(after, [cursorKey])) || undefined
                                return { index, analysis, first, after: cursor?.value }
                            })
                        )
                        const result = await dbPool.query<{
                            repositories: [null] | RepoSpec[]
                        }>(sql`
                            select json_agg(l) as "repositories"
                            from jsonb_to_recordset(${input}::jsonb) as input("index" int, "analysis" uuid, "first" int, "after" text)
                            left join lateral (
                                select distinct "repository"
                                from analyzed_commits
                                where analyzed_commits.analysis = input.analysis
                                -- pagination:
                                and (input.after is null or analyzed_commits.repository >= input.after) -- include one before to know whether there is a previous page
                                order by "repository" asc
                                limit input.first + 1 -- query one more to know whether there is a next page
                            ) l on true
                            group by input."index"
                            order by input."index"
                        `)
                        return result.rows.map(({ repositories }, i) => {
                            const spec = specs[i]
                            if (isNullArray(repositories)) {
                                repositories = []
                            }
                            return connectionFromOverfetchedResult(repositories, spec, cursorKey)
                        })
                    }),
                { batchScheduleFn, cacheKeyFn: spec => spec.analysis + connectionArgsKeyFn(spec) }
            ),
        },

        commit: {
            byOid: new DataLoader(
                specs =>
                    trace(span, 'loaders.commit.byOid', async span => {
                        const commitsByRepo = await mapCommitRepoSpecsGroupedByRepo(
                            specs,
                            ({ repository, commits }) =>
                                git
                                    .getCommits({
                                        repoRoot,
                                        repository,
                                        commitOids: commits.map(c => c.commit),
                                    })
                                    .catch(err => asError(err))
                        )
                        return specs.map(spec => {
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
                    }),
                { batchScheduleFn, cacheKeyFn: repoAtCommitCacheKeyFn }
            ),

            forRepository: new DataLoader(
                specs =>
                    trace(span, 'loaders.commit.forRepository', async span =>
                        mapPromise(
                            specs,
                            async ({ repository, first, after, startRevision, path, ...filterOptions }) => {
                                try {
                                    const afterOffset = (after && cursorToOffset(after)) || 0
                                    assert(
                                        !afterOffset || (!isNaN(afterOffset) && afterOffset >= 0),
                                        'Invalid cursor'
                                    )
                                    const commits = await git
                                        .log({
                                            ...filterOptions,
                                            repoRoot,
                                            repository,
                                            startRevision,
                                            skip: afterOffset,
                                            maxCount: typeof first === 'number' ? first + 1 : undefined,
                                        })
                                        .tap((commit: Commit) =>
                                            loaders.commit.byOid.prime(
                                                { repository, commit: commit.oid },
                                                commit
                                            )
                                        )
                                        .toArray()

                                    return connectionFromOverfetchedResult<Commit>(
                                        commits,
                                        { first, after },
                                        (node, index) => offsetToCursor(afterOffset + index)
                                    )
                                } catch (err) {
                                    return asError(err)
                                }
                            },
                            { concurrency: 100 }
                        )
                    ),
                {
                    batchScheduleFn,
                    cacheKeyFn: ({
                        repository,
                        first,
                        after,
                        startRevision,
                        messagePattern,
                        path,
                        since,
                        until,
                    }) =>
                        objectHash({
                            repository,
                            first,
                            after,
                            startRevision,
                            messagePattern,
                            path,
                            since,
                            until,
                        }),
                }
            ),

            forAnalysis: new DataLoader(
                specs =>
                    trace(span, 'loaders.commit.forAnalysis', async span => {
                        const cursorKey: CursorKey<RepoSpec & CommitSpec> = ['repository', 'commit']
                        const input = JSON.stringify(
                            specs.map(({ analysis, first, after }, index) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<CommitSpec & RepoSpec>(after, [cursorKey])) ||
                                    undefined
                                return { index, analysis, first, after: cursor?.value }
                            })
                        )
                        const result = await dbPool.query<{
                            repoCommitSpecs: [null] | (RepoSpec & CommitSpec)[]
                        }>(sql`
                            select json_agg(c) as "repoCommitSpecs"
                            from jsonb_to_recordset(${input}::jsonb) as input("index" int, "analysis" uuid, "first" int, "after" text)
                            left join lateral (
                                select "commit", "repository"
                                from analyzed_commits
                                where analyzed_commits.analysis = input.analysis
                                -- pagination:
                                and (input.after is null or analyzed_commits."repository" || analyzed_commits."commit" >= input.after) -- include one before to know whether there is a previous page
                                order by "repository", "commit" asc
                                limit input.first + 1 -- query one more to know whether there is a next page
                            ) c on true
                            group by input."index"
                            order by input."index"
                        `)
                        return result.rows.map(({ repoCommitSpecs }, i) => {
                            const spec = specs[i]
                            if (isNullArray(repoCommitSpecs)) {
                                repoCommitSpecs = []
                            }
                            return connectionFromOverfetchedResult(repoCommitSpecs, spec, cursorKey)
                        })
                    }),
                { batchScheduleFn, cacheKeyFn: spec => spec.analysis + connectionArgsKeyFn(spec) }
            ),
        },
    }

    return loaders
}
