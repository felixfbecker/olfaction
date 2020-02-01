import * as path from 'path'
import { sortBy } from 'lodash'
import sql from 'sql-template-strings'
import { CodeSmell, CodeSmellInput, UUID, GitObjectID } from './models'
import { ClientBase } from 'pg'
import { DBContext } from './util'
import { Loaders } from './loaders'

/**
 * Inserts a code smell into the database.
 */
export async function insertCodeSmell(
    {
        analysisId,
        repositoryName,
        commitOid,
    }: {
        analysisId: UUID
        repositoryName: string
        commitOid: GitObjectID
    },
    { kind, message, locations, lifespan, ordinal }: CodeSmellInput,
    { db, loaders }: { db: ClientBase; loaders: Loaders }
): Promise<CodeSmell> {
    // Normalization
    message = message?.trim() || null
    locations = locations || []
    for (const location of locations) {
        if (path.posix.isAbsolute(location.file)) {
            throw new Error(`File path must be relative to repository root: ${location.file}`)
        }
        location.file = path.normalize(location.file)
    }
    locations = sortBy(locations, [
        l => l.file,
        l => l.range.start.line,
        l => l.range.start.character,
        l => l.range.end.line,
        l => l.range.end.character,
    ])

    const locationsJson = JSON.stringify(locations)

    // Get or create lifespan with ID passed from client
    const lifespanResult = await db.query<{
        id: UUID
    }>(sql`
        insert into code_smell_lifespans (id, kind, repository, analysis)
        values (${lifespan}, ${kind}, ${repositoryName}, ${analysisId})
        on conflict on constraint code_smell_lifespans_pkey do nothing
        returning id
    `)
    const lifespanId = lifespanResult.rows[0]?.id ?? lifespan // if not defined, it already existed
    const result = await db.query<CodeSmell>(sql`
        insert into code_smells
                    ("commit", "message", locations, lifespan, ordinal)
        values      (${commitOid}, ${message}, ${locationsJson}::jsonb, ${lifespanId}, ${ordinal})
        returning   id, "commit", "message", locations, lifespan, ordinal
    `)
    const codeSmell = result.rows[0]
    loaders.codeSmell.byId.prime(codeSmell.id, codeSmell)
    loaders.codeSmell.byOrdinal.prime(codeSmell, codeSmell)
    return codeSmell
}
