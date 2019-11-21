import {
    buildSchema,
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
} from 'graphql'
import { readFileSync } from 'fs'
import graphQLHTTPServer from 'express-graphql'
import * as pg from 'pg'
import { listRepositories, validateRepository, validateCommit, Signature, Commit } from '../git'
import sql from 'sql-template-strings'
import { Loaders, createLoaders } from '../loaders'
import { Location, CodeSmell, UUID, RepoSpec, CommitSpec, FileSpec, Range, File } from '../models'
import { transaction } from '../util'
import { Duration, ZonedDateTime } from '@js-joda/core'
import * as chardet from 'chardet'

const schemaIDL = readFileSync(__dirname + '/../../schema/schema.graphql', 'utf-8')
const schema = buildSchema(schemaIDL)

interface Context {
    loaders: Loaders
}

export function createGraphQLHandler({ db, repoRoot }: { db: pg.Client; repoRoot: string }) {
    var encodingArg: GraphQLFieldConfigArgumentMap = {
        encoding: {
            type: GraphQLString,
            description: 'Encoding to use. If not given, will try to auto-detect, otherwise default to UTF8.',
        },
    }

    var SignatureType = new GraphQLObjectType<Signature>({
        name: 'Signature',
        fields: {
            name: { type: GraphQLNonNull(GraphQLString) },
            email: { type: GraphQLNonNull(GraphQLString) },
            date: { type: GraphQLNonNull(GraphQLString) },
        },
    })

    var CommitType: GraphQLObjectType = new GraphQLObjectType<Commit>({
        name: 'Commit',
        fields: () => ({
            sha: { type: GraphQLNonNull(GraphQLString) },
            message: { type: GraphQLNonNull(GraphQLString) },
            author: { type: GraphQLNonNull(SignatureType) },
            committer: { type: GraphQLNonNull(SignatureType) },
            parents: { type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CommitType))) },
            files: {
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(FileType))),
                description: 'The files that existed at this commit in the repository',
                // resolve: ({ repository, sha }: Commit, args: {}, { loaders }: Context): Promise<File[]> => {
                //     return loaders.files.load({ repository, commit: sha })
                // },
            },
            codeSmells: {
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellType))),
            },
        }),
    })

    var FileType = new GraphQLObjectType<File>({
        name: 'File',
        fields: {
            path: { type: GraphQLNonNull(GraphQLString) },
            content: {
                type: GraphQLString,
                args: encodingArg,
                description:
                    'The file content from the git repository. null if the repository was not uploaded.',
            },
            linesCount: { type: GraphQLInt },
            commit: { type: GraphQLNonNull(CommitType) },
        },
    })

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

    var CodeSmellType: GraphQLObjectType = new GraphQLObjectType({
        name: 'CodeSmell',
        fields: () => ({
            id: {
                type: GraphQLNonNull(GraphQLID),
            },
            locations: {
                type: GraphQLList(GraphQLNonNull(LocationType)),
            },
            lifeSpan: {
                type: GraphQLNonNull(CodeSmellLifeSpanType),
                description: 'The complete lifespan of this code smell throughout commit history.',
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

    var CodeSmellLifeSpanType = new GraphQLObjectType({
        name: 'CodeSmellLifeSpan',
        description: 'A lifespan of a code smell throughout commit history.',
        fields: {
            kind: { type: GraphQLString },
            instances: {
                type: new GraphQLList(CodeSmellType),
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
        },
    })

    var RepositoryType = new GraphQLObjectType({
        name: 'Repository',
        fields: {
            name: { type: GraphQLString },
            commit: {
                type: CommitType,
                // resolve: (source: RepoSpec, { sha }: { sha: string }, { loaders }: Context) => {
                //     return loaders.commit.load({ ...source, commit: sha })
                // },
            },
            codeSmellLifespans: {
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellLifeSpanType))),
            },
        },
    })

    var CodeSmellInputType = new GraphQLInputObjectType({
        name: 'CodeSmellInput',
        fields: {
            id: {
                type: GraphQLNonNull(GraphQLID),
                description:
                    'A client-provided globally unique ID (UUID). This is used to declare predecessors. If a code smell with this ID already exists, the code smell will be updated.',
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
            predecessor: {
                type: GraphQLString,
                description:
                    'Optional ID of a code smell in a previous commit, to define the life span of this code smell through the commit history.This will set up the successor for the referenced code smell as well.',
            },
            successor: {
                type: GraphQLString,
                description:
                    'Optional ID of a code smell in a previous commit, to define the life span of this code smell through commits. This will set up the predecessor for the referenced code smell as well.',
            },
            locations: {
                type: GraphQLList(GraphQLNonNull(LocationInputType)),
                description: 'Locations of the code smell in the code.',
            },
        },
    })

    const dynamicSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
            name: 'Query',
            fields: {
                codeSmell: {
                    type: CodeSmellType,
                },
                repository: {
                    type: RepositoryType,
                    args: {
                        name: {
                            type: GraphQLNonNull(GraphQLString),
                        },
                    },
                },
                repositories: {
                    type: GraphQLNonNull(GraphQLList(RepositoryType)),
                },
            },
        }),
        mutation: new GraphQLObjectType({
            name: 'Mutation',
            fields: {
                addCodeSmells: {
                    args: {
                        repository: {
                            type: GraphQLNonNull(GraphQLString),
                        },
                        commit: {
                            type: GraphQLNonNull(GraphQLString),
                        },
                        codeSmells: {
                            type: GraphQLNonNull(GraphQLList(CodeSmellInputType)),
                        },
                    },
                    type: GraphQLNonNull(GraphQLList(GraphQLNonNull(CodeSmellType))),
                },
            },
        }),
    })

    class RepositoryResolver {
        constructor(public name: string) {}

        commit({ sha }: { sha: string }, context: Context) {
            return createCommitResolver({ commit: sha, repository: this.name }, context)
        }

        async codeSmellLifespans({}, { loaders }: Context): Promise<CodeSmellLifeSpanResolver[]> {
            // Get the start of lifespans
            const starters = await loaders.codeSmellStartersInRepository.load(this.name)
            return starters!.map(starter => new CodeSmellLifeSpanResolver(starter))
        }
    }

    class CodeSmellLifeSpanResolver {
        constructor(private firstCodeSmell: Pick<CodeSmell, 'id' | 'kind'>) {}

        get kind(): string {
            return this.firstCodeSmell.kind
        }

        async duration({}, { loaders }: Context): Promise<string> {
            const instances = (await loaders.codeSmellLifespan.load(this.firstCodeSmell.id))!
            const start = (await loaders.commit.load(instances[0]))!.committer.date
            const end = (await loaders.commit.load(instances[instances.length - 1]))!.committer.date
            return Duration.between(ZonedDateTime.parse(start), ZonedDateTime.parse(end)).toString()
        }

        async interval({}, { loaders }: Context): Promise<string> {
            const instances = (await loaders.codeSmellLifespan.load(this.firstCodeSmell.id))!
            const start = (await loaders.commit.load(instances[0]))!.committer.date
            const end = (await loaders.commit.load(instances[instances.length - 1]))!.committer.date
            return `${start}/${end}`
        }

        async instances({}, { loaders }: Context): Promise<CodeSmellResolver[]> {
            const instances = await loaders.codeSmellLifespan.load(this.firstCodeSmell.id)
            return instances!.map(codeSmell => new CodeSmellResolver(codeSmell))
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
        async lifeSpan({}, { loaders }: Context) {
            const starter = (await loaders.codeSmellStarter.load(this.codeSmell.id))!
            return new CodeSmellLifeSpanResolver(starter)
        }
        async predecessor({}, { loaders }: Context): Promise<CodeSmellResolver | null> {
            if (!this.codeSmell.predecessor) {
                return null
            }
            const codeSmell = await loaders.codeSmell.load(this.codeSmell.predecessor)
            return codeSmell && new CodeSmellResolver(codeSmell)
        }

        async successor({}, { loaders }: Context): Promise<CodeSmellResolver | null> {
            const codeSmell = await loaders.codeSmellSuccessor.load(this.codeSmell.id)
            return codeSmell && new CodeSmellResolver(codeSmell)
        }

        commit({}, context: Context) {
            return createCommitResolver(this.codeSmell, context)
        }

        locations() {
            return this.codeSmell.locations.map(
                location => new LocationResolver({ ...location, ...this.codeSmell })
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
        async content({ encoding }: { encoding: string }, { loaders }: Context): Promise<string> {
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

    const createCommitResolver = async (spec: RepoSpec & CommitSpec, { loaders }: Context) => {
        const commit = await loaders.commit.load(spec)
        return (
            commit && {
                ...commit,
                repository: () => new RepositoryResolver(commit.repository),
                subject: (): string => commit.message.split('\n', 1)[0],
                async codeSmells({}, { loaders }: Context): Promise<CodeSmellResolver[]> {
                    const codeSmells = await loaders.codeSmellsByCommit.load(spec)
                    return codeSmells.map(codeSmell => new CodeSmellResolver(codeSmell))
                },
                async files({}, { loaders }: Context): Promise<FileResolver[]> {
                    const files = await loaders.files.load(spec)
                    return files.map(file => new FileResolver({ ...spec, file: file.path }))
                },
            }
        )
    }

    class FileResolver {
        constructor(private spec: FileSpec & RepoSpec & CommitSpec) {}

        path(): string {
            return this.spec.file
        }

        async content({ encoding }: { encoding: string }, { loaders }: Context): Promise<string> {
            const content = await loaders.fileContent.load(this.spec)
            const decoder = new TextDecoder(encoding || chardet.detect(content) || undefined)
            return decoder.decode(content)
        }

        commit({}, context: Context) {
            return createCommitResolver(this.spec, context)
        }

        async linesCount({}, { loaders }: Context) {
            const buffer = await loaders.fileContent.load(this.spec)
            const decoder = new TextDecoder(chardet.detect(buffer) || undefined)
            const str = decoder.decode(buffer)
            return str.split('\n').length
        }
    }

    const query = {
        repository({ name }: { name: string }) {
            return new RepositoryResolver(name)
        },
        async repositories() {
            const repositoryNames = await listRepositories({ repoRoot })
            return repositoryNames.map(name => new RepositoryResolver(name))
        },
        async codeSmell({ id }: { id: UUID }, { loaders }: Context) {
            const codeSmell = await loaders.codeSmell.load(id)
            return codeSmell && new CodeSmellResolver(codeSmell)
        },
    }

    interface CodeSmellInput {
        id: string
        predecessor: string | null
        successor: string | null
        kind: string
        message: string
        locations: Location[]
    }

    const mutation = {
        async addCodeSmells(
            {
                repository,
                commit,
                codeSmells,
            }: {
                repository: string
                commit: string
                codeSmells: CodeSmellInput[]
            },
            { loaders }: Context
        ): Promise<CodeSmellResolver[]> {
            await validateRepository({ repository, repoRoot })
            await validateCommit({ repository, commit, repoRoot })

            return await transaction(db, async () => {
                return await Promise.all(
                    codeSmells.map(async ({ id, kind, message, predecessor, successor, locations }) => {
                        const locationsJson = JSON.stringify(locations)
                        const result = await db.query<CodeSmell>(sql`
                            insert into code_smells
                                        (id, repository, "commit", kind, "message", predecessor, locations)
                            values      (${id}, ${repository}, ${commit}, ${kind}, ${message}, ${predecessor}, ${locationsJson}::jsonb)
                            returning   id, repository, "commit", kind, "message", predecessor, locations
                        `)
                        await db.query(
                            sql`update code_smells set predecessor = ${id} where id = ${successor}`
                        )
                        const codeSmell = result.rows[0]
                        loaders.codeSmell.prime(codeSmell.id, codeSmell)
                        return new CodeSmellResolver(codeSmell)
                    })
                )
            })
        },
    }

    const rootValue = {
        ...query,
        ...mutation,
    }

    return graphQLHTTPServer(() => {
        const context: Context = {
            loaders: createLoaders({ db, repoRoot }),
        }
        return {
            schema: dynamicSchema,
            rootValue,
            graphiql: true,
            context,
            customFormatErrorFn: err => {
                console.error(err.originalError)
                return {
                    name: err.originalError ? err.originalError.name : err.name,
                    ...formatError(err),
                    stack: err.stack!.split('\n'),
                }
            },
        }
    })
}
