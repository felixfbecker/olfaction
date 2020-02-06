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
import { trace, ParentSpanContext } from './tracing'
import pMap from 'p-map'

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
            AnalysisSpec & ForwardConnectionArguments & Partial<RepoSpec>,
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
 * item after than requested (if possible), which will be stripped
 * and used to determine pagination info.
 *
 * @param result The result array from the DB with one more item at the end.
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
        await pMap(
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
                            from unnest(${ids}::int[]) with ordinality as input_id
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
                        const input = specs.map(({ lifespan, ordinal }) => ({ lifespan, ordinal }))
                        const result = await dbPool.query<CodeSmell | NullFields<CodeSmell>>(sql`
                            with input as materialized (
                                select
                                    ordinality,
                                    nullif(spec->>'lifespan', '')::uuid as "analysis",
                                    nullif(spec->'ordinal', 'null')::int as "ordinal",
                                    nullif(spec->'first', 'null')::int as "first",
                                    nullif(spec->>'after', '')::uuid as "after"
                                from rows from (unnest(${input}::jsonb[])) with ordinality as spec
                            )
                            select code_smells.*
                            from input
                            left join code_smells on code_smells.lifespan = input.lifespan
                            and code_smells.ordinal = input."ordinal"
                            order by input."ordinality"
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
                                        (after && parseCursor<CodeSmell>(after, [['id']])) || undefined
                                    return {
                                        repository: repository || undefined,
                                        commit: commit || undefined,
                                        fileQuery: file ? [{ file }] : undefined,
                                        pathPattern: pathPattern || undefined,
                                        kind: kind || undefined,
                                        analysis: analysis || undefined,
                                        first,
                                        after: cursor && parseInt(cursor.value, 10),
                                    }
                                }
                            )
                            // Group by query shape, defined by which filters are passed
                            .groupBy(spec => objectHash(spec, { excludeValues: true }))
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
                                            nullif(spec->'fileQuery', 'null')::jsonb as "fileQuery",
                                            nullif(spec->>'pathPattern', '')::text as "pathPattern",
                                            nullif(spec->>'kind', '')::text as "kind",
                                            nullif(spec->'first', 'null')::int as "first",
                                            nullif(spec->>'after', '')::int as "after"
                                        from rows from (unnest(${specArr}::jsonb[])) with ordinality as spec
                                    )
                                    select json_agg(c order by c.id) as "codeSmells"
                                    from input
                                    left join lateral (
                                        select "id", "message", "ordinal", "lifespan", "commit", "locations",
                                            jsonb_build_object('id', lifespan, 'repository', repository, 'kind', kind, 'analysis', analysis) as "lifespanObject"
                                        from code_smells
                                        where true
                                `
                                if (firstSpec.repository) {
                                    query.append(sql` and code_smells."repository" = input."repository" `)
                                }
                                if (firstSpec.analysis) {
                                    query.append(sql` and code_smells."analysis" = input."analysis" `)
                                }
                                if (firstSpec.kind) {
                                    query.append(sql` and code_smells."kind" = input."kind" `)
                                }
                                if (firstSpec.commit) {
                                    query.append(sql` and code_smells."commit" = input."commit" `)
                                }
                                if (firstSpec.fileQuery) {
                                    query.append(sql` and code_smells."locations" @> input."fileQuery" `)
                                }
                                if (firstSpec.pathPattern) {
                                    query.append(sql`
                                        and exists (
                                            select "file"
                                            from jsonb_to_recordset(code_smells.locations) as locations("file" text)
                                            where "file" ~* input."pathPattern"
                                        )
                                    `)
                                }
                                if (firstSpec.after) {
                                    query.append(sql` and code_smells."id" > input."after" `)
                                }
                                if (typeof firstSpec.first === 'number') {
                                    query.append(sql` order by code_smells.id asc `)
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

                        const results = await pMap(
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
                        // Instances are sorted by ordinal, so we need to paginate by the ordinal.
                        const cursorKey: CursorKey<CodeSmell> = ['ordinal']
                        const queries = IterableX.from(specs)
                            .map(({ lifespan, first, after }) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<CodeSmell>(after, [cursorKey])) || undefined
                                const cursorOrdinal = cursor && parseInt(cursor.value, 10)
                                return { lifespan, first, after: cursorOrdinal }
                            })
                            .groupBy(spec => objectHash(spec, { excludeValues: true }))
                            .map(specGroup => {
                                const specArr = specGroup.toArray()
                                const firstSpec = specArr[0]
                                const query = sql`
                                    with input as materialized (
                                        select
                                            ordinality,
                                            nullif(spec->>'lifespan', '')::uuid as "lifespan",
                                            nullif(spec->'first', 'null')::int as "first",
                                            nullif(spec->>'after', '')::int as "after"
                                        from rows from (unnest(${specArr}::jsonb[])) with ordinality as spec
                                    )
                                    select json_agg(c order by c."ordinal") as instances
                                    from input
                                    left join lateral (
                                        select code_smells.*
                                        from code_smells
                                        where input.lifespan = code_smells.lifespan
                                `
                                // Pagination
                                if (firstSpec.after) {
                                    query.append(sql` and code_smells.ordinal > input.after `)
                                }
                                if (typeof firstSpec.first === 'number') {
                                    query.append(sql`
                                        order by code_smells.ordinal
                                        limit input.first + 1
                                    `)
                                }
                                query.append(sql`
                                    ) c on true
                                    group by input."ordinality"
                                    order by input."ordinality"
                                `)
                                return query
                            })
                        const results = await pMap(
                            queries,
                            async query => {
                                const result = await dbPool.query<{
                                    instances: CodeSmell[] | [null]
                                }>(query)
                                return result.rows
                            },
                            { concurrency: 100 }
                        )
                        return IterableX.from(results)
                            .flatMap(rows => rows)
                            .map(({ instances }, i) => {
                                const spec = specs[i]
                                if (isNullArray(instances)) {
                                    instances = []
                                }
                                for (const codeSmell of instances) {
                                    loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
                                }
                                return connectionFromOverfetchedResult(instances, spec, cursorKey)
                            })
                            .toArray()
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
                                const cursor =
                                    (after && parseCursor<Analysis>(after, [['name']])) || undefined
                                return { index, first, after: cursor?.value }
                            })
                        )
                        const result = await dbPool.query<{
                            analyses: [null] | Analysis[]
                        }>(sql`
                            select json_agg(a order by a."name" asc) as "analyses"
                            from jsonb_to_recordset(${input}::jsonb) as input("index" int, "first" int, "after" uuid)
                            left join lateral (
                                select analyses.*
                                from analyses
                                -- pagination:
                                where (input.after is null or analyses.id > input.after)
                                order by analyses."name" asc
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
                                    (after && parseCursor<CodeSmellLifespan>(after, [['id']])) || undefined
                                return {
                                    repository: repository || undefined,
                                    analysis: analysis || undefined,
                                    kind: kind || undefined,
                                    first,
                                    after: cursor?.value || undefined,
                                }
                            })
                            // Group by query shape, defined by which filters are passed
                            .groupBy(spec => objectHash(spec, { excludeValues: true }))
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
                                    select json_agg(l order by l.id) as "lifespans"
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
                                    query.append(sql` and code_smell_lifespans.id > input.after `)
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

                        const results = await pMap(
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
                    pMap(
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
                    pMap(
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
                        const queries = IterableX.from(specs)
                            .map(({ analysis, first, after }, index) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<RepoSpec>(after, [cursorKey])) || undefined
                                return { index, analysis, first, after: cursor?.value }
                            })
                            .groupBy(spec => objectHash(spec, { excludeValues: true }))
                            .map(specGroup => {
                                const specArr = specGroup.toArray()
                                const firstSpec = specArr[0]
                                const query = sql`
                                    with input as materialized (
                                        select
                                            ordinality,
                                            nullif(spec->>'analysis', '')::uuid as "analysis",
                                            nullif(spec->'first', 'null')::int as "first",
                                            nullif(spec->>'after', '')::text as "after"
                                        from rows from (unnest(${specArr}::jsonb[])) with ordinality as spec
                                    )
                                    select json_agg(l order by l."repository" asc) as "repositories"
                                    from input
                                    left join lateral (
                                        select distinct analyzed_commits."repository"
                                        from analyzed_commits
                                        where analyzed_commits.analysis = input.analysis
                                `
                                // Pagination
                                if (firstSpec.after) {
                                    query.append(sql` and analyzed_commits.repository > input.after `)
                                }
                                if (typeof firstSpec.first === 'number') {
                                    query.append(sql`
                                        order by analyzed_commits."repository" asc
                                        limit input.first + 1
                                    `)
                                }
                                query.append(sql`
                                    ) l on true
                                    group by input."ordinality"
                                    order by input."ordinality"
                                `)
                                return query
                            })

                        const results = await pMap(queries, async query => {
                            const result = await dbPool.query<{
                                repositories: [null] | RepoSpec[]
                            }>(query)
                            return result.rows
                        })
                        return IterableX.from(results)
                            .flatMap(rows => rows)
                            .map(({ repositories }, i) => {
                                const spec = specs[i]
                                if (isNullArray(repositories)) {
                                    repositories = []
                                }
                                return connectionFromOverfetchedResult(repositories, spec, cursorKey)
                            })
                            .toArray()
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
                        pMap(
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
                                            // Using offset-based pagination is okay because
                                            // the git history after a given start commit is immutable.
                                            skip: afterOffset && afterOffset + 1,
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
                        const queries = IterableX.from(specs)
                            .map(({ analysis, repository, first, after }) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor =
                                    (after && parseCursor<CommitSpec & RepoSpec>(after, [cursorKey])) ||
                                    undefined
                                return { analysis, repository, first, after: cursor?.value }
                            })
                            .groupBy(spec => objectHash(spec, { excludeValues: true }))
                            .map(specGroup => {
                                const specArr = specGroup.toArray()
                                const firstSpec = specArr[0]
                                const query = sql`
                                    with input as materialized (
                                        select
                                            ordinality,
                                            nullif(spec->>'repository', '')::text as "repository",
                                            nullif(spec->>'analysis', '')::uuid as "analysis",
                                            nullif(spec->'first', 'null')::int as "first",
                                            nullif(spec->>'after', '')::text as "after"
                                        from rows from (unnest(${specArr}::jsonb[])) with ordinality as spec
                                    )
                                    select json_agg(c order by c."repository", c."commit" asc) as "repoCommitSpecs"
                                    from input
                                    left join lateral (
                                        select analyzed_commits."commit", analyzed_commits."repository"
                                        from analyzed_commits
                                        where analyzed_commits.analysis = input.analysis
                                `
                                if (firstSpec.repository) {
                                    query.append(sql` and analyzed_commits.repository = input.repository `)
                                }
                                if (firstSpec.after) {
                                    query.append(
                                        sql` and analyzed_commits."repository" || analyzed_commits."commit" > input.after `
                                    )
                                }
                                if (typeof firstSpec.first === 'number') {
                                    query.append(sql`
                                        order by analyzed_commits."repository", analyzed_commits."commit" asc
                                        limit input.first + 1 -- query one more to know whether there is a next page
                                    `)
                                }
                                query.append(sql`
                                    ) c on true
                                    group by input."ordinality"
                                    order by input."ordinality"
                                `)
                                return query
                            })

                        const results = await pMap(queries, async query => {
                            const result = await dbPool.query<{
                                repoCommitSpecs: [null] | (RepoSpec & CommitSpec)[]
                            }>(query)
                            return result.rows
                        })
                        return IterableX.from(results)
                            .flatMap(rows => rows)
                            .map(({ repoCommitSpecs }, i) => {
                                const spec = specs[i]
                                if (isNullArray(repoCommitSpecs)) {
                                    repoCommitSpecs = []
                                }
                                return connectionFromOverfetchedResult(repoCommitSpecs, spec, cursorKey)
                            })
                            .toArray()
                    }),
                {
                    batchScheduleFn,
                    cacheKeyFn: ({ analysis, repository, after, first }) =>
                        objectHash({ analysis, repository, after, first }),
                }
            ),
        },
    }

    return loaders
}
