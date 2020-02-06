import {
    formatError,
    GraphQLObjectType,
    GraphQLNonNull,
    GraphQLString,
    GraphQLList,
    GraphQLSchema,
    GraphQLID,
    GraphQLFieldConfigArgumentMap,
    GraphQLInt,
    GraphQLInputObjectType,
    execute,
    GraphQLEnumType,
    GraphQLScalarType,
    Kind,
} from 'graphql'
import graphQLHTTPServer from 'express-graphql'
import {
    listRepositories,
    checkRepositoryExists,
    checkCommitExists,
    validateObjectID,
    GitLogFilters,
    resolveRepoDir,
} from '../git'
import sql from 'sql-template-strings'
import {
    Loaders,
    createLoaders,
    ForwardConnectionArguments,
    KindFilter,
    DirectoryFilter,
    PathPatternFilter,
} from '../loaders'
import {
    Location,
    CodeSmell,
    UUID,
    RepoSpec,
    CommitSpec,
    FileSpec,
    Range,
    File,
    CodeSmellLifespan,
    Commit,
    Signature,
    RepoRootSpec,
    CodeSmellInput,
    ChangeKind,
    Analysis,
    AnalysisName,
    CodeSmellSpec,
    CodeSmellLifespanSpec,
    GitObjectID,
    RepositoryCodeSmellsInput,
} from '../models'
import { transaction, mapConnectionNodes, DBContext, withDBConnection } from '../util'
import { Duration, ZonedDateTime } from '@js-joda/core'
import * as chardet from 'chardet'
import {
    connectionDefinitions,
    forwardConnectionArgs,
    Connection,
    connectionFromArray,
    mutationWithClientMutationId,
} from 'graphql-relay'
import { last, identity, sortBy } from 'lodash'
import sloc from 'sloc'
import * as path from 'path'
import { UnknownCodeSmellError, UnknownCodeSmellLifespanError, UnknownAnalysisError } from '../errors'
import pMap from 'p-map'
import rmfr from 'rmfr'
import { trace, ParentSpanContext } from '../tracing'
import { ClientBase } from 'pg'
import { Span } from 'opentracing'
import { insertCodeSmell } from '../insert'

type GraphQLArg<T> = T extends undefined ? Exclude<T, undefined> | null : T
/**
 * Ensures all properties use `null` instead of `undefined`, as GraphQL only
 * knows `null`.
 */
type GraphQLArgs<T> = {
    [K in keyof T]: GraphQLArg<T[K]>
}

interface Context extends ParentSpanContext {
    loaders: Loaders
}

export interface GraphQLHandler {
    rootValue: unknown
    schema: GraphQLSchema
}
export function createGraphQLHandler({ dbPool, repoRoot }: DBContext & RepoRootSpec): GraphQLHandler {
    const refreshViews = (db: ClientBase, span?: Span) =>
        trace(span, 'refreshViews', () => db.query(sql`refresh materialized view "code_smells_for_commit"`))

    var encodingArg: GraphQLFieldConfigArgumentMap = {
        encoding: {
            type: GraphQLString,
            description: 'Encoding to use. If not given, will try to auto-detect, otherwise default to UTF8.',
        },
    }
    var kindFilterArg: GraphQLFieldConfigArgumentMap = {
        kind: {
            type: GraphQLString,
            description: 'Only return code smells with this kind.',
        },
    }
    var codeSmellPathPatternArg: GraphQLFieldConfigArgumentMap = {
        pathPattern: {
            type: GraphQLString,
            description:
                'Only return code smells that affect a file matching the given path pattern (regular expression).',
        },
    }

    var GitObjectIDType = new GraphQLScalarType({
        name: 'GitObjectID',
        description: 'A 40-character Git object ID.',
        serialize: identity,
        parseValue: validateObjectID,
        parseLiteral: ast => {
            if (ast.kind !== Kind.STRING) {
                throw new Error('Git object ID must be String')
            }
            return validateObjectID(ast.value)
        },
    })

    var SignatureType = new GraphQLObjectType<Signature>({
        name: 'Signature',
        fields: {
            name: { type: GraphQLNonNull(GraphQLString) },
            email: { type: GraphQLNonNull(GraphQLString) },
            date: { type: GraphQLNonNull(GraphQLString) },
        },
    })

    var FileChangeKindEnum = new GraphQLEnumType({
        name: 'FileChangeKind',
        values: {
            ADDED: { value: ChangeKind.Added },
            COPIED: { value: ChangeKind.Copied },
            DELETED: { value: ChangeKind.Deleted },
            MODIFIED: { value: ChangeKind.Modified },
            RENAMED: { value: ChangeKind.Renamed },
            TYPE_CHANGED: { value: ChangeKind.TypeChanged },
        },
    })

    // FUTURE:
    /* var FileDifferenceType = new GraphQLObjectType({
        name: 'FileDifference',
        description: 'The difference of a file between two revisions.',
        fields: () => ({
            changeKind: {
                description: 'The change kind git detected comparing to the base revision.',
                type: GraphQLNonNull(FileChangeKindEnum),
            },
            headFile: {
                type: FileType,
                description:
                    'The version of the file at the head revision. null if the file no longer exists in the head revision.',
            },
            baseFile: {
                type: FileType,
                description:
                    'The version of the file in the base revision. null if that commit did not contain the file.',
            },
            // FUTURE
            // hunks: {}
            // patch: { type: GraphQLNonNull(GraphQLString) }
        }),
    */

    var CombinedFileDifferenceType = new GraphQLObjectType({
        name: 'CombinedFileDifference',
        description:
            "The difference between two versions of a file in [Git's default combined diff format](https://git-scm.com/docs/git-diff#_combined_diff_format)." +
            'This format is used to represent a combined diff for comparisons with potentially multiple base revisions, e.g. to compare a file in a commit to its parents.' +
            'It will only list files that were modified from all base revisions.',
        fields: () => ({
            changeKinds: {
                description:
                    'For each base revision, the change kind git detected comparing to that revision.',
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(FileChangeKindEnum))),
            },
            headFile: {
                type: FileType,
                description:
                    'The version of the file at the head revision. null if the file no longer exists in the head revision.',
            },
            baseFiles: {
                type: GraphQLNonNull(GraphQLList(FileType)),
                description:
                    'For each base revision, the file in that revision. Will contain null if that commit did not contain the file.',
            },
        }),
    })
    var { connectionType: CombinedFileDifferenceConnectionType } = connectionDefinitions({
        nodeType: CombinedFileDifferenceType,
    })

    var CommitType: GraphQLObjectType = new GraphQLObjectType<Commit>({
        name: 'Commit',
        description: 'A git commit object.',
        fields: () => ({
            oid: { type: GraphQLNonNull(GitObjectIDType) },
            message: { type: GraphQLNonNull(GraphQLString) },
            subject: { type: GraphQLNonNull(GraphQLString) },
            author: { type: GraphQLNonNull(SignatureType) },
            committer: { type: GraphQLNonNull(SignatureType) },
            parents: { type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CommitType))) },
            repository: { type: GraphQLNonNull(RepositoryType) },
            combinedFileDifferences: {
                description:
                    "The file differences between this commit and its parents in [Git's combined diff format](https://git-scm.com/docs/git-diff-tree#_combined_diff_format)." +
                    'This list contains one element for each file that is different in this commit when compared to one of its parents.',
                args: forwardConnectionArgs,
                type: GraphQLNonNull(CombinedFileDifferenceConnectionType),
            },
            // FUTURE
            // fileDifferences: {
            //     description:
            //         'The file differences for each parent commit, like git show -m. This list contains one element for each parent of the commit, with the file differences when comparing to that commit.',
            //     type: GraphQLNonNull(
            //         GraphQLList(GraphQLNonNull(GraphQLList(GraphQLNonNull(FileDifferenceType))))
            //     ),
            // },
            files: {
                args: {
                    ...forwardConnectionArgs,
                    directory: {
                        description: 'Return all files in a given directory and its subdirectories.',
                        type: GraphQLString,
                    },
                    pathPattern: {
                        description: 'Return only files that match the provided regular expression.',
                        type: GraphQLString,
                    },
                },
                type: GraphQLNonNull(FileConnectionType),
                description: 'The files that existed at this commit in the repository',
            },
            codeSmells: {
                type: GraphQLNonNull(CodeSmellConnectionType),
                args: {
                    ...kindFilterArg,
                    ...codeSmellPathPatternArg,
                    ...forwardConnectionArgs,
                },
            },
        }),
    })
    var { connectionType: CommitConnectionType } = connectionDefinitions({ nodeType: CommitType })

    var LineCounts = new GraphQLObjectType<Record<sloc.Key, number>>({
        name: 'LineCounts',
        fields: {
            total: {
                description: 'Physical lines',
                type: GraphQLNonNull(GraphQLInt),
            },
            source: {
                description: 'Lines of code (source)',
                type: GraphQLInt,
            },
            comment: {
                description: 'Lines with comments',
                type: GraphQLInt,
            },
            single: {
                description: 'Lines with single-line comments',
                type: GraphQLInt,
            },
            block: {
                description: 'Lines with block comments',
                type: GraphQLInt,
            },
            mixed: {
                description: 'Lines mixed up with source and comments',
                type: GraphQLInt,
            },
            blockEmpty: {
                description: 'Empty lines within block comments',
                type: GraphQLInt,
            },
            empty: {
                description: 'Empty lines',
                type: GraphQLInt,
            },
            todo: {
                description: 'Lines with TODOs',
                type: GraphQLInt,
            },
        },
    })

    var FileType = new GraphQLObjectType<File>({
        name: 'File',
        fields: () => ({
            path: { type: GraphQLNonNull(GraphQLString) },
            content: {
                type: GraphQLString,
                args: encodingArg,
                description:
                    'The file content from the git repository. null if the repository was not uploaded.',
            },
            commit: {
                description: 'The commit this file exists at.',
                type: GraphQLNonNull(CommitType),
            },
            codeSmells: {
                description: 'The code smells that exist in this file.',
                args: { ...kindFilterArg, ...forwardConnectionArgs },
                type: GraphQLNonNull(CodeSmellConnectionType),
            },
            lineCounts: {
                description: 'The amount of lines in this file.',
                type: GraphQLNonNull(LineCounts),
            },
        }),
    })
    var { connectionType: FileConnectionType } = connectionDefinitions({ nodeType: FileType })

    var positionFields = {
        line: {
            type: GraphQLNonNull(GraphQLInt),
            description: 'The 0-based line number of the position',
        },
        character: {
            type: GraphQLNonNull(GraphQLInt),
            description: 'The 0-based character number of the position',
        },
    }
    var PositionType = new GraphQLObjectType({
        name: 'Position',
        fields: positionFields,
    })
    var PositionInputType = new GraphQLInputObjectType({
        name: 'PositionInput',
        fields: positionFields,
    })

    var rangeFields = <P extends GraphQLObjectType | GraphQLInputObjectType>(positionType: P) => ({
        start: {
            type: GraphQLNonNull(positionType),
            description: 'The start position of the range, inclusive.',
        },
        end: {
            type: GraphQLNonNull(positionType),
            description: 'The end position of the range, exclusive.',
        },
    })

    var RangeType = new GraphQLObjectType({
        name: 'Range',
        fields: rangeFields(PositionType),
    })
    var RangeInputType = new GraphQLInputObjectType({
        name: 'RangeInput',
        fields: rangeFields(PositionInputType),
    })

    var LocationType = new GraphQLObjectType({
        name: 'Location',
        fields: {
            file: {
                type: GraphQLNonNull(FileType),
            },
            range: {
                type: RangeType,
            },
            content: {
                type: GraphQLString,
                args: encodingArg,
                description: 'The content of the range.',
            },
        },
    })
    var LocationInputType = new GraphQLInputObjectType({
        name: 'LocationInput',
        fields: {
            file: {
                type: GraphQLNonNull(GraphQLString),
                description: 'The file path of the location.',
            },
            range: {
                type: RangeInputType,
            },
        },
    })

    var AnalysisType = new GraphQLObjectType({
        name: 'Analysis',
        fields: () => ({
            name: {
                description: 'The unique name of the analysis',
                type: GraphQLNonNull(GraphQLString),
            },
            analyzedRepositories: {
                description: 'The repositories that were analyzed as part of this analysis.',
                type: GraphQLNonNull(RepositoryConnectionType),
                args: forwardConnectionArgs,
            },
            analyzedCommits: {
                description:
                    'The commits that were analyzed as part of this analysis, across all repositories.',
                type: GraphQLNonNull(CommitConnectionType),
                args: {
                    ...forwardConnectionArgs,
                    repository: { type: GraphQLString },
                },
            },
            codeSmellLifespans: {
                description: 'The code smell lifespans that were found in this analysis.',
                type: GraphQLNonNull(CodeSmellLifespanConnectionType),
                args: {
                    ...kindFilterArg,
                    ...forwardConnectionArgs,
                },
            },
            codeSmells: {
                description: 'The code smell lifespans that were found in this analysis.',
                type: GraphQLNonNull(CodeSmellConnectionType),
                args: {
                    ...kindFilterArg,
                    ...codeSmellPathPatternArg,
                    ...forwardConnectionArgs,
                },
            },
        }),
    })
    var { connectionType: AnalysisConnectionType } = connectionDefinitions({ nodeType: AnalysisType })

    var CodeSmellType: GraphQLObjectType = new GraphQLObjectType({
        name: 'CodeSmell',
        fields: () => ({
            id: {
                type: GraphQLNonNull(GraphQLID),
            },
            message: {
                type: GraphQLString,
                description: 'A message for this specific code smell instance.',
            },
            locations: {
                type: GraphQLList(GraphQLNonNull(LocationType)),
            },
            lifespan: {
                type: GraphQLNonNull(CodeSmellLifespanType),
                description: 'The complete lifespan of this code smell throughout commit history.',
            },
            ordinal: {
                type: GraphQLNonNull(GraphQLInt),
                description: 'The position of the code smell in its lifespan.',
            },
            predecessor: {
                type: CodeSmellType,
                description:
                    'This code smell in a previous commit. This may not be in the direct parent commit because not every commit must be analyzed, but it is guaranteed to be in an ascendant commit.',
            },
            successor: {
                type: CodeSmellType,
                description:
                    'This code smell in a later commit. This may not be in the direct child commit because not every commit must be analyzed, but it is guaranteed to be in a descendant commit.',
            },
            commit: {
                type: CommitType,
                description: 'The commit this code smell was detected in.',
            },
        }),
    })
    var { connectionType: CodeSmellConnectionType } = connectionDefinitions({ nodeType: CodeSmellType })

    var CodeSmellLifespanType = new GraphQLObjectType({
        name: 'CodeSmellLifespan',
        description: 'A lifespan of a code smell throughout commit history.',
        fields: {
            id: {
                type: GraphQLNonNull(GraphQLID),
            },
            kind: {
                description: 'The kind of code smell.',
                type: GraphQLNonNull(GraphQLString),
            },
            instances: {
                args: forwardConnectionArgs,
                type: GraphQLNonNull(CodeSmellConnectionType),
                description: 'The instances of the code smell throughout commit history.',
            },
            duration: {
                type: GraphQLNonNull(GraphQLString),
                description:
                    'The duration this code smell was present in the codebase as an ISO8601 duration string',
            },
            interval: {
                type: GraphQLNonNull(GraphQLString),
                description:
                    'The interval this code smell was present in the codebase as an ISO8601 interval string with start/end',
            },
            analysis: {
                type: GraphQLNonNull(AnalysisType),
                description: 'The analysis this code smell was detected in.',
            },
            repository: {
                type: GraphQLNonNull(RepositoryType),
                description: 'The repository the code smell was detected in.',
            },
    })

    var { connectionType: CodeSmellLifespanConnectionType } = connectionDefinitions({
        nodeType: CodeSmellLifespanType,
    })

    var RepositoryType = new GraphQLObjectType({
        name: 'Repository',
        fields: {
            name: { type: GraphQLString },
            commits: {
                args: {
                    ...forwardConnectionArgs,
                    messagePattern: {
                        type: GraphQLString,
                        description:
                            'Limit the commits to ones with log message that matches the specified pattern (regular expression).' +
                            "The pattern supports Git's extended regular expression syntax.",
                    },
                    startRevision: {
                        type: GraphQLString,
                        defaultValue: 'HEAD',
                        description: 'The revision to start at (e.g. a commit, a branch, a tag, etc).',
                    },
                    since: {
                        type: GraphQLString,
                        description: 'Return commits more recent than a specific date.',
                    },
                    until: {
                        type: GraphQLString,
                        description: 'Return commits older than a specific date.',
                    },
                    path: {
                        type: GraphQLString,
                        description: 'Return only the history of the given directory or file.',
                    },
                },
                type: GraphQLNonNull(CommitConnectionType),
            },
            commit: {
                type: CommitType,
                args: {
                    oid: {
                        type: GraphQLNonNull(GitObjectIDType),
                    },
                },
                // resolve: (source: RepoSpec, { oid }: { oid: string }, { loaders }: Context) => {
                //     return loaders.commit.load({ ...source, commit: oid })
                // },
            },
            codeSmellLifespans: {
                args: {
                    ...forwardConnectionArgs,
                    ...kindFilterArg,
                },
                type: GraphQLNonNull(CodeSmellLifespanConnectionType),
            },
        },
    })
    var { connectionType: RepositoryConnectionType } = connectionDefinitions({
        nodeType: RepositoryType,
    })

    var CodeSmellInputType = new GraphQLInputObjectType({
        name: 'CodeSmellInput',
        fields: {
            lifespan: {
                type: GraphQLNonNull(GraphQLID),
                description:
                    'A client-provided ID to associate code smell instances in multiple commits as part of the same code smell lifespan',
            },
            ordinal: {
                type: GraphQLNonNull(GraphQLInt),
            },
            kind: {
                type: GraphQLNonNull(GraphQLString),
                description:
                    'An arbitrary string that uniquely identifies the kind of code smell, e.g. "GodClass". Must be the same for every instance.',
            },
            message: {
                type: GraphQLString,
                description:
                    'A message for the code smell, which can be specific to this particular instance.',
            },
            locations: {
                type: GraphQLList(GraphQLNonNull(LocationInputType)),
                description: 'Locations of the code smell in the code.',
            },
        },
    })

    var CommitCodeSmellsInputType = new GraphQLInputObjectType({
        name: 'CommitCodeSmellsInput',
        fields: {
            oid: {
                description: 'The ID of the commit.',
                type: GraphQLNonNull(GitObjectIDType),
            },
            codeSmells: {
                description: 'The code smells for the commit.',
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellInputType))),
            },
        },
    })

    var RepositoryCodeSmellsInputType = new GraphQLInputObjectType({
        name: 'RepositoryCodeSmellsInput',
        fields: {
            name: {
                description: 'The name of the repository (must exist).',
                type: GraphQLNonNull(GraphQLString),
            },
            commits: {
                description: 'The code smells to add by commit.',
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CommitCodeSmellsInputType))),
            },
        },
    })

    const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
            name: 'Query',
            fields: {
                codeSmell: {
                    type: CodeSmellType,
                    args: {
                        id: {
                            type: GraphQLNonNull(GraphQLID),
                            description: 'The ID of the code smell to query.',
                        },
                    },
                },
                codeSmellLifespan: {
                    type: CodeSmellLifespanType,
                    args: {
                        id: {
                            type: GraphQLNonNull(GraphQLID),
                            description: 'The ID of the code smell lifespan to query.',
                        },
                    },
                },
                repository: {
                    type: RepositoryType,
                    args: {
                        name: {
                            type: GraphQLNonNull(GraphQLString),
                            description: 'The name under which the repository was uploaded.',
                        },
                    },
                },
                repositories: {
                    args: forwardConnectionArgs,
                    type: GraphQLNonNull(RepositoryConnectionType),
                },
                analyses: {
                    args: forwardConnectionArgs,
                    type: GraphQLNonNull(AnalysisConnectionType),
                },
                analysis: {
                    args: {
                        name: { type: GraphQLNonNull(GraphQLString) },
                    },
                    type: GraphQLNonNull(AnalysisType),
                },
            },
        }),
        mutation: new GraphQLObjectType({
            name: 'Mutation',
            fields: {
                createAnalysis: mutationWithClientMutationId({
                    name: 'CreateAnalysis',
                    description: 'Create an analysis to add code smells to.',
                    inputFields: {
                        name: {
                            type: GraphQLNonNull(GraphQLString),
                            description: 'A unique name for the analysis to address it by.',
                        },
                    },
                    outputFields: {
                        analysis: {
                            type: GraphQLNonNull(AnalysisType),
                            description: 'The created analysis.',
                        },
                    },
                    mutateAndGetPayload: async ({ name }: AnalysisName) => {
                        const result = await dbPool.query<Analysis>(
                            sql`insert into analyses ("name") values (${name}) returning "id", "name"`
                        )
                        return { analysis: new AnalysisResolver(result.rows[0]) }
                    },
                }),
                addCodeSmells: mutationWithClientMutationId({
                    name: 'AddCodeSmells',
                    description: 'Add code smells for a commit of a repository to an analysis.',
                    inputFields: {
                        analysis: {
                            description: 'The name of the analysis the code smells should be added to.',
                            type: GraphQLNonNull(GraphQLString),
                        },
                        repositories: {
                            description: 'The code smells to add by repository.',
                            type: GraphQLNonNull(GraphQLList(GraphQLNonNull(RepositoryCodeSmellsInputType))),
                        },
                    },
                    outputFields: {
                        codeSmells: {
                            type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellType))),
                            description: 'The created code smells.',
                        },
                    },
                    mutateAndGetPayload: async (
                        {
                            repositories,
                            analysis,
                        }: {
                            /** Analysis name */
                            analysis: string
                            repositories: RepositoryCodeSmellsInput[]
                        },
                        { loaders, span }: Context
                    ): Promise<{ codeSmells: CodeSmellResolver[] }> => {
                        const codeSmellResolvers = await withDBConnection(dbPool, db =>
                            transaction(db, span, async () => {
                                // Get analysis ID, check if exists
                                const analysisResult = await db.query<{
                                    id: UUID
                                }>(sql`select id from analyses where "name" = ${analysis}`)
                                if (analysisResult.rows.length === 0) {
                                    throw new UnknownAnalysisError({ name: analysis })
                                }
                                const analysisId = analysisResult.rows[0].id

                                const codeSmellResolvers = await pMap(
                                    repositories,
                                    async repositoryInput => {
                                        await checkRepositoryExists({
                                            repository: repositoryInput.name,
                                            repoRoot,
                                        })
                                        return pMap(
                                            repositoryInput.commits,
                                            async commitInput => {
                                                await checkCommitExists({
                                                    repository: repositoryInput.name,
                                                    commit: commitInput.oid,
                                                    repoRoot,
                                                })
                                                await db.query<{}>(sql`
                                                    insert into analyzed_commits (analysis, repository, "commit")
                                                    values (${analysisId}, ${repositoryInput.name}, ${commitInput.oid})
                                                    on conflict on constraint analysed_revisions_pkey do nothing
                                                `)
                                                return pMap(
                                                    commitInput.codeSmells,
                                                    async codeSmellInput =>
                                                        new CodeSmellResolver(
                                                            await insertCodeSmell(
                                                                {
                                                                    analysisId,
                                                                    repositoryName: repositoryInput.name,
                                                                    commitOid: commitInput.oid,
                                                                },
                                                                codeSmellInput,
                                                                { db, loaders }
                                                            )
                                                        ),
                                                    { concurrency: 10 }
                                                )
                                            },
                                            { concurrency: 10 }
                                        )
                                    },
                                    { concurrency: 10 }
                                )
                                await refreshViews(db, span)
                                return codeSmellResolvers
                            })
                        )
                        return { codeSmells: codeSmellResolvers.flat(2) }
                    },
                }),
                deleteAnalysis: mutationWithClientMutationId({
                    name: 'DeleteAnalysis',
                    description: 'Delete an analysis and all its code smells. Repositories are not deleted.',
                    inputFields: { name: { type: GraphQLNonNull(GraphQLString) } },
                    outputFields: {},
                    mutateAndGetPayload: async ({ name }: AnalysisName, { span }: Context) =>
                        withDBConnection(dbPool, db =>
                            transaction(db, span, async () => {
                                const result = await db.query(
                                    sql`delete from analyses where "name" = ${name}`
                                )
                                if (result.rowCount === 0) {
                                    throw new UnknownAnalysisError({ name })
                                }
                                await refreshViews(db, span)
                                return {}
                            })
                        ),
                }),
                deleteRepository: mutationWithClientMutationId({
                    name: 'DeleteRepository',
                    description: 'Delete a repository and all its code smells.',
                    inputFields: {
                        repository: {
                            type: GraphQLNonNull(GraphQLString),
                            description: 'The repository to delete.',
                        },
                    },
                    outputFields: {},
                    mutateAndGetPayload: async ({ repository }: RepoSpec, { span }: Context) => {
                        await checkRepositoryExists({ repository, repoRoot })
                        await withDBConnection(dbPool, async db => {
                            await transaction(db, span, async () => {
                                await db.query(
                                    sql`delete from code_smell_lifespans where repository = ${repository}`
                                )
                                await db.query(
                                    sql`delete from analyzed_commits where repository = ${repository}`
                                )
                            })
                            await refreshViews(db, span)
                            await rmfr(resolveRepoDir({ repoRoot, repository }))
                        })
                        return {}
                    },
                }),
                deleteCodeSmell: mutationWithClientMutationId({
                    name: 'DeleteCodeSmell',
                    description: 'Delete a code smell instance.',
                    inputFields: { id: { type: GraphQLNonNull(GraphQLID) } },
                    outputFields: {},
                    mutateAndGetPayload: async ({ codeSmell }: CodeSmellSpec, { span }: Context) => {
                        await withDBConnection(dbPool, async db => {
                            await transaction(db, span, async () => {
                                const result = await dbPool.query(
                                    sql`delete from code_smells where id = ${codeSmell}`
                                )
                                if (result.rowCount === 0) {
                                    throw new UnknownCodeSmellError({ codeSmell })
                                }
                                await refreshViews(db, span)
                            })
                        })
                        return {}
                    },
                }),
                deleteCodeSmellLifespan: mutationWithClientMutationId({
                    name: 'DeleteCodeSmellLifespan',
                    description: 'Delete a code smell lifespan and its instances.',
                    inputFields: { id: { type: GraphQLNonNull(GraphQLID) } },
                    outputFields: {},
                    mutateAndGetPayload: async ({ lifespan }: CodeSmellLifespanSpec, { span }: Context) => {
                        await withDBConnection(dbPool, async db => {
                            await transaction(db, span, async () => {
                                const result = await db.query(
                                    sql`delete from code_smell_lifespans where id = ${lifespan}`
                                )
                                if (result.rowCount === 0) {
                                    throw new UnknownCodeSmellLifespanError({ lifespan })
                                }
                                await refreshViews(db, span)
                            })
                        })
                        return {}
                    },
                }),
            },
        }),
    })

    class AnalysisResolver {
        constructor(private analysis: Analysis) {}
        name() {
            return this.analysis.name
        }
        async codeSmellLifespans(
            args: GraphQLArgs<ForwardConnectionArguments & KindFilter>,
            { loaders }: Context
        ) {
            const lifespans = await loaders.codeSmellLifespan.many.load({
                ...args,
                analysis: this.analysis.id,
            })
            return mapConnectionNodes(lifespans, lifespan => new CodeSmellLifespanResolver(lifespan))
        }
        async codeSmells(
            args: GraphQLArgs<ForwardConnectionArguments & KindFilter & PathPatternFilter>,
            { loaders }: Context
        ) {
            const codeSmells = await loaders.codeSmell.many.load({ ...args, analysis: this.analysis.id })
            return mapConnectionNodes(codeSmells, codeSmell => new CodeSmellResolver(codeSmell))
        }
        async analyzedCommits(
            args: GraphQLArgs<ForwardConnectionArguments & Partial<RepoSpec>>,
            { loaders }: Context
        ): Promise<Connection<CommitResolver>> {
            const connection = await loaders.commit.forAnalysis.load({
                ...args,
                analysis: this.analysis.id,
                repository: args.repository || undefined,
            })
            return {
                get pageInfo() {
                    return connection.pageInfo
                },
                edges: await pMap(
                    connection.edges,
                    async edge => {
                        const commit = await loaders.commit.byOid.load(edge.node)
                        return {
                            node: new CommitResolver(edge.node, commit),
                            get cursor() {
                                return edge.cursor
                            },
                        }
                    },
                    { concurrency: 100 }
                ),
            }
        }
        async analyzedRepositories(
            args: ForwardConnectionArguments,
            { loaders }: Context
        ): Promise<Connection<RepositoryResolver>> {
            const repos = await loaders.repository.forAnalysis.load({
                ...args,
                analysis: this.analysis.id,
            })
            return mapConnectionNodes(repos, ({ repository }) => new RepositoryResolver(repository))
        }
    }

    class RepositoryResolver {
        constructor(public name: string) {}

        async commits(
            args: GraphQLArgs<ForwardConnectionArguments & GitLogFilters>,
            { loaders }: Context
        ): Promise<Connection<CommitResolver>> {
            const connection = await loaders.commit.forRepository.load({
                ...args,
                messagePattern: args.messagePattern || undefined,
                startRevision: args.startRevision || undefined,
                since: args.since || undefined,
                until: args.until || undefined,
                path: args.path || undefined,
                repository: this.name,
            })
            return mapConnectionNodes(connection, node => new CommitResolver({ repository: this.name }, node))
        }

        async commit({ oid }: { oid: string }, { loaders }: Context) {
            const commit = await loaders.commit.byOid.load({ repository: this.name, commit: oid })
            return new CommitResolver({ repository: this.name }, commit)
        }

        async codeSmellLifespans(
            { kind, ...args }: GraphQLArgs<KindFilter & ForwardConnectionArguments>,
            { loaders }: Context
        ): Promise<Connection<CodeSmellLifespanResolver>> {
            const connection = await loaders.codeSmellLifespan.many.load({
                ...args,
                repository: this.name,
                kind,
            })
            return mapConnectionNodes(connection, node => new CodeSmellLifespanResolver(node))
        }
    }

    class CodeSmellLifespanResolver {
        constructor(private lifespan: CodeSmellLifespan) {}

        get id(): UUID {
            return this.lifespan.id
        }

        get kind(): string {
            return this.lifespan.kind
        }

        async duration(args: {}, { loaders }: Context): Promise<string> {
            const { repository, id: lifespan } = this.lifespan
            const instances = (await loaders.codeSmell.forLifespan.load({ lifespan }))!
            const start = (await loaders.commit.byOid.load({
                repository,
                commit: instances.edges[0].node.commit,
            }))!.committer.date
            const end = (await loaders.commit.byOid.load({
                repository,
                commit: last(instances.edges)!.node.commit,
            }))!.committer.date
            return Duration.between(ZonedDateTime.parse(start), ZonedDateTime.parse(end)).toString()
        }

        async interval(args: {}, { loaders }: Context): Promise<string> {
            const { repository, id: lifespan } = this.lifespan
            const instances = (await loaders.codeSmell.forLifespan.load({ lifespan }))!
            const start = (await loaders.commit.byOid.load({
                repository,
                commit: instances.edges[0].node.commit,
            }))!.committer.date
            const end = (await loaders.commit.byOid.load({
                repository,
                commit: last(instances.edges)!.node.commit,
            }))!.committer.date
            return `${start}/${end}`
        }

        async instances(
            args: ForwardConnectionArguments,
            { loaders }: Context
        ): Promise<Connection<CodeSmellResolver>> {
            const connection = await loaders.codeSmell.forLifespan.load({
                lifespan: this.lifespan.id,
                ...args,
            })
            return {
                get pageInfo() {
                    return connection.pageInfo
                },
                edges: connection.edges.map(edge => ({
                    node: new CodeSmellResolver(edge.node),
                    get cursor() {
                        return edge.cursor
                    },
                })),
            }
        }

        async analysis(args: {}, { loaders }: Context) {
            const analysis = await loaders.analysis.byId.load(this.lifespan.analysis)
            return new AnalysisResolver(analysis)
        }

        repository() {
            return new RepositoryResolver(this.lifespan.repository)
        }
    }

    class CodeSmellResolver {
        constructor(private codeSmell: CodeSmell) {}
        get id(): UUID {
            return this.codeSmell.id
        }
        get message(): string {
            return this.codeSmell.message
        }
        get ordinal(): number {
            return this.codeSmell.ordinal
        }
        async lifespan(args: {}, { loaders }: Context) {
            const lifespan = (await loaders.codeSmellLifespan.oneById.load(this.codeSmell.lifespan))!
            return new CodeSmellLifespanResolver(lifespan)
        }
        async predecessor(args: {}, { loaders }: Context): Promise<CodeSmellResolver | null> {
            try {
                const codeSmell = await loaders.codeSmell.byOrdinal.load({
                    lifespan: this.codeSmell.lifespan,
                    ordinal: this.codeSmell.ordinal - 1,
                })
                return new CodeSmellResolver(codeSmell)
            } catch (err) {
                if (err instanceof UnknownCodeSmellError) {
                    return null
                }
                throw err
            }
        }

        async successor(args: {}, { loaders }: Context): Promise<CodeSmellResolver | null> {
            try {
                const codeSmell = await loaders.codeSmell.byOrdinal.load({
                    lifespan: this.codeSmell.lifespan,
                    ordinal: this.codeSmell.ordinal + 1,
                })
                return new CodeSmellResolver(codeSmell)
            } catch (err) {
                if (err instanceof UnknownCodeSmellError) {
                    return null
                }
                throw err
            }
        }

        async commit(args: {}, { loaders }: Context): Promise<CommitResolver> {
            const { repository } = (await loaders.codeSmellLifespan.oneById.load(this.codeSmell.lifespan))!
            const commit = await loaders.commit.byOid.load({ repository, commit: this.codeSmell.commit })
            return new CommitResolver({ repository }, commit)
        }

        async locations(args: {}, { loaders }: Context) {
            const { repository } = (await loaders.codeSmellLifespan.oneById.load(this.codeSmell.lifespan))!
            return this.codeSmell.locations.map(
                location => new LocationResolver({ ...location, ...this.codeSmell, repository })
            )
        }
    }

    class LocationResolver {
        constructor(private spec: Location & RepoSpec & CommitSpec) {}
        file(): FileResolver {
            return new FileResolver(this.spec)
        }
        range(): Range {
            return this.spec.range
        }
        async content({ encoding }: EncodingArgs, { loaders }: Context): Promise<string> {
            const buffer = await loaders.fileContent.load(this.spec)
            const { start, end } = this.spec.range
            const decoder = new TextDecoder(encoding || chardet.detect(buffer) || undefined)
            const content = decoder.decode(buffer)
            const lines = content.split('\n').slice(start.line, end.line + 1)
            if (lines.length === 0) {
                return ''
            }
            if (lines.length === 1) {
                return lines[0].slice(start.character, end.character)
            }
            lines[0] = lines[0].slice(start.character)
            lines[lines.length - 1] = lines[lines.length - 1].slice(end.character)
            return lines.join('\n')
        }
    }

    class CommitResolver {
        private spec: RepoSpec & CommitSpec
        constructor({ repository }: RepoSpec, private commit: Commit) {
            this.spec = { repository, commit: commit.oid }
        }
        oid(): GitObjectID {
            return this.commit.oid
        }
        author(): Signature {
            return this.commit.author
        }
        committer(): Signature {
            return this.commit.committer
        }
        message(): string {
            return this.commit.message
        }

        subject(): string {
            return this.commit.message.split('\n', 1)[0]
        }
        async parents(args: {}, { loaders }: Context): Promise<CommitResolver[]> {
            const parentCommits = await pMap(this.commit.parents, parentOid =>
                loaders.commit.byOid.load({ ...this.spec, commit: parentOid })
            )
            return parentCommits.map(parent => new CommitResolver(this.spec, parent))
        }
        repository() {
            return new RepositoryResolver(this.spec.repository)
        }
        async combinedFileDifferences(args: ForwardConnectionArguments, { loaders }: Context) {
            const fileDifferences = await loaders.combinedFileDifference.forCommit.load(this.spec)
            return connectionFromArray(
                fileDifferences.map(difference => ({
                    changeKinds: difference.changeKinds,
                    headFile: () =>
                        difference.headPath && new FileResolver({ ...this.spec, file: difference.headPath }),
                    baseFiles: () =>
                        difference.basePaths.map(
                            basePath => basePath && new FileResolver({ ...this.spec, file: basePath })
                        ),
                })),
                args
            )
        }
        // fileDifferences: async (args: {}, { loaders }: Context) => {
        //     const fileDifferences = await loaders.fileDifference.forCommit.load(spec)
        //     return fileDifferences.map(differencesToParent =>
        //         differencesToParent.map(difference => ({
        //             changeKind: difference.changeKind,
        //             headFile: () =>
        //                 difference.newPath && new FileResolver({ ...spec, file: difference.headPath }),
        //             baseFile: () =>
        //                 difference.oldPath && new FileResolver({ ...spec, file: difference.basePath }),
        //         }))
        //     )
        // },
        async codeSmells(
            args: GraphQLArgs<ForwardConnectionArguments & KindFilter & PathPatternFilter>,
            { loaders }: Context
        ): Promise<Connection<CodeSmellResolver>> {
            const connection = await loaders.codeSmell.many.load({ ...this.spec, ...args })
            return mapConnectionNodes(connection, node => new CodeSmellResolver(node))
        }
        async files(
            {
                directory,
                pathPattern,
                ...connectionArgs
            }: GraphQLArgs<ForwardConnectionArguments & DirectoryFilter & PathPatternFilter>,
            { loaders }: Context
        ): Promise<Connection<FileResolver>> {
            let files = await loaders.files.load({ ...this.spec, directory })
            if (pathPattern) {
                const regex = new RegExp(pathPattern, 'i')
                files = files.filter(file => regex.test(file.path))
            }

            return connectionFromArray(
                files.map(file => new FileResolver({ ...this.spec, file: file.path })),
                connectionArgs
            )
        }
    }

    interface EncodingArgs {
        encoding: string | null
    }

    class FileResolver {
        constructor(private spec: FileSpec & RepoSpec & CommitSpec) {}

        path(): string {
            return this.spec.file
        }

        async content({ encoding }: EncodingArgs, { loaders }: Context): Promise<string> {
            const content = await loaders.fileContent.load(this.spec)
            const decoder = new TextDecoder(encoding || chardet.detect(content) || undefined)
            return decoder.decode(content)
        }

        async commit(args: {}, { loaders }: Context) {
            const commit = await loaders.commit.byOid.load(this.spec)
            return new CommitResolver(this.spec, commit)
        }

        async codeSmells(args: ForwardConnectionArguments & KindFilter, { loaders }: Context) {
            const codeSmells = await loaders.codeSmell.many.load({
                ...this.spec,
                ...args,
                pathPattern: null,
            })
            return codeSmells
        }

        async lineCounts(args: EncodingArgs, context: Context) {
            const content = await this.content(args, context)
            try {
                return sloc(content, path.extname(this.spec.file).slice(1))
            } catch (err) {
                if (err.message.includes('not supported')) {
                    return {
                        total: content.match(/\n/g)?.length ?? 0,
                    }
                }
                throw err
            }
        }
    }

    const query = {
        async repository({ name }: { name: string }) {
            await checkRepositoryExists({ repository: name, repoRoot })
            return new RepositoryResolver(name)
        },
        async repositories(args: ForwardConnectionArguments): Promise<Connection<RepositoryResolver>> {
            const repositoryNames = await listRepositories({ repoRoot })
            return connectionFromArray(
                repositoryNames.map(name => new RepositoryResolver(name)),
                args
            )
        },
        async codeSmell({ id }: { id: UUID }, { loaders }: Context) {
            const codeSmell = await loaders.codeSmell.byId.load(id)
            return new CodeSmellResolver(codeSmell)
        },
        async codeSmellLifespan({ id }: { id: UUID }, { loaders }: Context) {
            const lifespan = await loaders.codeSmellLifespan.oneById.load(id)
            return new CodeSmellLifespanResolver(lifespan)
        },
        async analysis({ name }: GraphQLArgs<AnalysisName>, { loaders }: Context) {
            const analysis = await loaders.analysis.byName.load(name)
            return new AnalysisResolver(analysis)
        },
        async analyses(args: ForwardConnectionArguments, { loaders }: Context) {
            const analyses = await loaders.analysis.all.load(args)
            return mapConnectionNodes(analyses, analysis => new AnalysisResolver(analysis))
        },
    }

    return { schema, rootValue: query }
}

export const createGraphQLContext = (options: DBContext & RepoRootSpec & ParentSpanContext) => ({
    loaders: createLoaders(options),
})

export const createGraphQLHTTPHandler = (options: GraphQLHandler & DBContext & RepoRootSpec) =>
    graphQLHTTPServer(req => ({
        ...options,
        customExecuteFn: args =>
            trace(req.span, 'graphql.execute', span =>
                execute({
                    ...args,
                    contextValue: {
                        ...createGraphQLContext({ ...options, span }),
                        span,
                    },
                })
            ),
        graphiql: true,
        customFormatErrorFn: err => {
            console.error(err.originalError)
            return {
                name: err.originalError?.name,
                detail: (err.originalError as any)?.detail,
                ...formatError(err),
                stack: err.stack!.split('\n'),
            }
        },
    }))
