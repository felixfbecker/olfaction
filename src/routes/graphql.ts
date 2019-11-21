import { buildSchema, formatError } from 'graphql'
import { readFileSync } from 'fs'
import graphQLHTTPServer from 'express-graphql'
import * as pg from 'pg'
import { listRepositories, validateRepository, validateCommit } from '../git'
import sql from 'sql-template-strings'
import { Loaders, createLoaders } from '../loaders'
import { Location, CodeSmell, UUID, RepoSpec, CommitSpec, FileSpec } from '../models'
import { transaction } from '../util'
import { Duration, ZonedDateTime } from '@js-joda/core'
import * as chardet from 'chardet'

const schemaIDL = readFileSync(__dirname + '/../schema/schema.graphql', 'utf-8')
const schema = buildSchema(schemaIDL)

interface Context {
    loaders: Loaders
}

// const SignatureType = new GraphQLObjectType<Signature>({
//     name: 'Signature',
//     fields: {
//         name: { type: GraphQLNonNull(GraphQLString) },
//         email: { type: GraphQLNonNull(GraphQLString) },
//         date: { type: GraphQLNonNull(GraphQLString) },
//     },
// })

// const FileType = new GraphQLObjectType<File>({
//     name: 'File',
//     fields: {
//         path: { type: GraphQLNonNull(GraphQLString) },
//         content: {
//             type: GraphQLString,
//             description: 'The file content from the git repository. null if the repository was not uploaded.',
//             resolve: (
//                 file: File & RepoSpec & CommitSpec,
//                 args: {},
//                 { loaders }: Context
//             ): Promise<string | null> => loaders.fileContent.load(file),
//         },
//     },
// })

// const CommitType = new GraphQLObjectType<Commit>({
//     name: 'Commit',
//     fields: {
//         sha: { type: GraphQLNonNull(GraphQLString) },
//         message: { type: GraphQLNonNull(GraphQLString) },
//         author: { type: GraphQLNonNull(SignatureType) },
//         committer: { type: GraphQLNonNull(SignatureType) },
//         files: {
//             type: GraphQLNonNull(FileType),
//             resolve: ({ repository, sha }: Commit, args: {}, { loaders }: Context): Promise<File[]> => {
//                 return loaders.files.load({ repository, commit: sha })
//             },
//         },
//     },
// })

// const CodeSmellLifeSpanType = new GraphQLObjectType({
//     name: 'CodeSmellLifeSpanType',
//     fields: {
//         kind: { type: GraphQLString },
//         instances: {
//             type: new GraphQLList(CodeSmellType),
//         },
//     },
// })

// const RepositoryType = new GraphQLObjectType({
//     name: 'Repository',
//     fields: {
//         name: { type: GraphQLString },
//         commit: {
//             type: CommitType,
//             resolve: (source: RepoSpec, { sha }: { sha: string }, { loaders }: Context) => {
//                 return loaders.commit.load({ ...source, commit: sha })
//             },
//         },
//     },
// })

// const dynamicSchema = new GraphQLSchema({
//     query: new GraphQLObjectType({
//         name: 'Query',
//         fields: {
//             repositories: {
//                 type: GraphQLNonNull(GraphQLList(RepositoryType)),
//             },
//         },
//     }),
// })

export function createGraphQLHandler({ db, repoRoot }: { db: pg.Client; repoRoot: string }) {
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

        get kind() {
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
        file() {
            return new FileResolver(this.spec)
        }
        range() {
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
        public get path() {
            return this.spec.file
        }

        constructor(private spec: FileSpec & RepoSpec & CommitSpec) {}

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
        ) {
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
            schema,
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
