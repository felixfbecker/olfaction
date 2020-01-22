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
    logDuration,
    DBContext,
    CursorKey,
} from './util'
import assert from 'assert'
import {
    Connection,
    Edge,
    ConnectionArguments,
    connectionFromArraySlice,
    cursorToOffset,
    getOffsetWithDefault,
    offsetToCursor,
} from 'graphql-relay'
import { IterableX } from 'ix/iterable'
import {
    UnknownCodeSmellError,
    UnknownCommitError,
    UnknownCodeSmellLifespanError,
    UnknownAnalysisError,
} from './errors'
import objectHash from 'object-hash'
import mapPromise from 'p-map'

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
        .map((node, index) => ({ node, cursor: makeCursor(node, index) }))
        .skip(after ? 1 : 0)
        .take(first ?? Infinity)
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

export const createLoaders = ({ dbPool, repoRoot }: DBContext & RepoRootSpec): Loaders => {
    var loaders: Loaders = {
        codeSmell: {
            byId: new DataLoader<CodeSmell['id'], CodeSmell>(async ids => {
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

            byOrdinal: new DataLoader<CodeSmellLifespanSpec & Pick<CodeSmell, 'ordinal'>, CodeSmell, string>(
                async specs => {
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
                },
                { cacheKeyFn: ({ lifespan, ordinal }) => `${lifespan}#${ordinal}` }
            ),

            many: new DataLoader(
                logDuration('loaders.codeSmell.forCommit', async specs => {
                    const input = JSON.stringify(
                        specs.map(
                            (
                                { repository, commit, analysis, file, kind, pathPattern, first, after },
                                index
                            ) => {
                                assert(!first || first >= 0, 'Parameter first must be positive')
                                const cursor = (after && parseCursor<CodeSmell>(after, ['id'])) || undefined
                                return {
                                    index,
                                    repository: repository || null,
                                    commit: commit || null,
                                    fileQuery: file ? [{ file }] : null,
                                    pathPattern: pathPattern || null,
                                    kind: kind || null,
                                    analysis: analysis || null,
                                    first,
                                    after: cursor?.value,
                                }
                            }
                        )
                    )
                    const result = await dbPool.query<{
                        codeSmells: [null] | (CodeSmell & { lifespanObject: CodeSmellLifespan })[]
                    }>(sql`
                        select input."index", array_agg(to_jsonb(c)) as "codeSmells"
                        from jsonb_to_recordset(${input}::jsonb) as input(
                            "index" int,
                            "commit" text,
                            "repository" text,
                            "analysis" uuid,
                            "fileQuery" jsonb,
                            "pathPattern" text,
                            "kind" text,
                            "first" int,
                            "after" uuid
                        )
                        left join lateral (
                            select code_smells.*, to_jsonb(code_smell_lifespans) as "lifespanObject"
                            from code_smells
                            inner join code_smell_lifespans on code_smells.lifespan = code_smell_lifespans.id
                            where (input.repository is null or code_smell_lifespans.repository = input.repository)
                            and (input.analysis is null or code_smell_lifespans.analysis = input.analysis)
                            and (input.commit is null or code_smells.commit = input.commit)
                            and (input."fileQuery" is null or code_smells.locations @> input."fileQuery")
                            and (input."pathPattern" is null or exists (select "file" from jsonb_to_recordset(code_smells.locations) as locations("file" text) where "file" ~* input."pathPattern"))
                            and (input.kind is null or code_smell_lifespans.kind = input.kind)
                            -- pagination:
                            and (input.after is null or code_smells.id >= input.after) -- include one before to know whether there is a previous page
                            order by id asc
                            limit input.first + 1 -- query one more to know whether there is a next page
                        ) c on true
                        group by input."index"
                        order by input."index"
                    `)
                    assert.strictEqual(result.rows.length, specs.length, 'Expected length to be the same')
                    return result.rows.map(
                        ({ codeSmells }, i): Connection<CodeSmell> => {
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
                            return connectionFromOverfetchedResult(codeSmells, spec, ['id'])
                        }
                    )
                }),
                {
                    cacheKeyFn: ({ repository, commit, analysis, file, kind, first, after }) =>
                        objectHash({ repository, commit, analysis, file, kind, first, after }),
                }
            ),

            forLifespan: new DataLoader(
                async specs => {
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
                },
                { cacheKeyFn: args => args.lifespan + connectionArgsKeyFn(args) }
            ),
        },

        analysis: {
            all: new DataLoader(
                async specs => {
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
                        select array_agg(to_jsonb(a)) as "analyses"
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
                },
                { cacheKeyFn: connectionArgsKeyFn }
            ),
            byId: new DataLoader<Analysis['id'], Analysis>(
                logDuration('loaders.analysis.byId', async ids => {
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
            byName: new DataLoader<Analysis['name'], Analysis>(
                logDuration('loaders.analysis.byName', async names => {
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
            oneById: new DataLoader<CodeSmellLifespan['id'], CodeSmellLifespan>(
                logDuration('loaders.codeSmellLifespan.oneById', async ids => {
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
                async specs => {
                    const input = JSON.stringify(
                        specs.map(({ repository, analysis, kind, first, after }, index) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CodeSmellLifespan>(after, ['id'])) || undefined
                            return {
                                index,
                                repository: repository || null,
                                analysis: analysis || null,
                                kind: kind || null,
                                first,
                                after: cursor?.value,
                            }
                        })
                    )
                    const result = await dbPool.query<{
                        lifespans: [null] | CodeSmellLifespan[]
                    }>(sql`
                        select array_agg(to_jsonb(l)) as "lifespans"
                        from jsonb_to_recordset(${input}::jsonb) as input("index" int, "repository" text, "analysis" uuid, "kind" text, "first" int, "after" uuid)
                        left join lateral (
                            select code_smell_lifespans.*
                            from code_smell_lifespans
                            where (input.repository is null or code_smell_lifespans.repository = input.repository)
                            and (input.analysis is null or code_smell_lifespans.analysis = input.analysis)
                            and (input.kind is null or code_smell_lifespans.kind = input.kind)
                            -- pagination:
                            and (input.after is null or code_smell_lifespans.id >= input.after) -- include one before to know whether there is a previous page
                            order by id asc
                            limit input.first + 1 -- query one more to know whether there is a next page
                        ) l on true
                        group by input."index"
                        order by input."index"
                    `)
                    return result.rows.map(({ lifespans }, i) => {
                        const spec = specs[i]
                        if (isNullArray(lifespans)) {
                            lifespans = []
                        }
                        for (const lifespan of lifespans) {
                            loaders.codeSmellLifespan.oneById.prime(lifespan.id, lifespan)
                        }
                        return connectionFromOverfetchedResult(lifespans, spec, ['id'])
                    })
                },
                {
                    cacheKeyFn: ({ repository, analysis, kind, first, after }) =>
                        objectHash({ repository, analysis, kind, first, after }),
                }
            ),
        },

        files: new DataLoader(
            logDuration('loaders.files', commits =>
                mapPromise(
                    commits,
                    ({ repository, commit, directory }) =>
                        git.listFiles({ repository, commit, repoRoot, directory }).catch(err => asError(err)),
                    { concurrency: 100 }
                )
            ),
            {
                cacheKeyFn: ({ repository, commit, directory }) =>
                    objectHash({ repository, commit, directory }),
            }
        ),

        combinedFileDifference: {
            forCommit: new DataLoader<RepoSpec & CommitSpec, CombinedFileDifference[], string>(
                async specs => {
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
                },
                { cacheKeyFn: repoAtCommitCacheKeyFn }
            ),
        },

        fileContent: new DataLoader(
            specs =>
                Promise.all(
                    specs.map(({ repository, commit, file }) =>
                        git.getFileContent({ repository, commit, repoRoot, file }).catch(err => asError(err))
                    )
                ),
            { cacheKeyFn: spec => repoAtCommitCacheKeyFn(spec) + fileKeyFn(spec) }
        ),

        repository: {
            forAnalysis: new DataLoader(
                logDuration('loaders.repository.forAnalysis', async specs => {
                    const cursorKey: CursorKey<RepoSpec> = ['repository']
                    const input = JSON.stringify(
                        specs.map(({ analysis, first, after }, index) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor = (after && parseCursor<RepoSpec>(after, [cursorKey])) || undefined
                            return { index, analysis, first, after: cursor?.value }
                        })
                    )
                    const result = await dbPool.query<{
                        repositories: [null] | RepoSpec[]
                    }>(sql`
                        select array_agg(to_jsonb(l)) as "repositories"
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
                { cacheKeyFn: spec => spec.analysis + connectionArgsKeyFn(spec) }
            ),
        },

        commit: {
            byOid: new DataLoader(
                async specs => {
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
                },
                { cacheKeyFn: repoAtCommitCacheKeyFn }
            ),

            forRepository: new DataLoader(
                logDuration('loaders.commit.forRepository', async specs =>
                    Promise.all(
                        specs.map(
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
                            }
                        )
                    )
                ),
                {
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
                logDuration('loaders.commit.forAnalysis', async specs => {
                    const cursorKey: CursorKey<RepoSpec & CommitSpec> = ['repository', 'commit']
                    const input = JSON.stringify(
                        specs.map(({ analysis, first, after }, index) => {
                            assert(!first || first >= 0, 'Parameter first must be positive')
                            const cursor =
                                (after && parseCursor<CommitSpec & RepoSpec>(after, [cursorKey])) || undefined
                            return { index, analysis, first, after: cursor?.value }
                        })
                    )
                    const result = await dbPool.query<{
                        repoCommitSpecs: [null] | (RepoSpec & CommitSpec)[]
                    }>(sql`
                        select array_agg(to_jsonb(c)) as "repoCommitSpecs"
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
                { cacheKeyFn: spec => spec.analysis + connectionArgsKeyFn(spec) }
            ),
        },
    }

    return loaders
}
