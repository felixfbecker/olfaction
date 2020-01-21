import { Client, ClientBase, Pool } from 'pg'
import sql from 'sql-template-strings'
import { Connection } from 'graphql-relay'
import { ExecutionResult } from 'graphql'
import { isEqual } from 'lodash'

export function keyBy<K, V>(items: Iterable<V>, by: (value: V) => K): Map<K, V> {
    const map = new Map<K, V>()
    for (const item of items) {
        map.set(by(item), item)
    }
    return map
}

export interface DBContext {
    dbPool: Pool
}

export async function withDBConnection<R>(pool: Pool, fn: (client: ClientBase) => Promise<R>): Promise<R> {
    const client = await pool.connect()
    try {
        return await fn(client)
    } finally {
        client.release()
    }
}

export async function transaction<T>(db: ClientBase, fn: () => Promise<T>): Promise<T> {
    await db.query(sql`BEGIN`)
    try {
        const result = await fn()
        await db.query(sql`COMMIT`)
        return result
    } catch (err) {
        await db.query(sql`ROLLBACK`)
        throw err
    }
}

/** Encode a string to Base64 */
export const base64encode = (str: string): string => Buffer.from(str, 'utf-8').toString('base64')

/** Decode a Base64 string */
export const base64decode = (base64: string): string => Buffer.from(base64, 'base64').toString('utf-8')

interface Cursor<T extends object> {
    /** The attribute that the cursor refers to */
    key: CursorKey<T>
    /** The serialized value the cursor points to (may need to be coerced). */
    value: string
}

/** A potentially compound key for a cursor. */
export type CursorKey<T extends object> = readonly (keyof T)[]

/**
 * Parses a string cursor as used in the olfaction API. A cursor is composed of
 * one or mupltiple target attributes seperated by a comma, a colon, and the
 * value of the property, all Base64 encoded.
 * E.g. `base64encode("id:6fcc41f6-772d-4601-b940-6012b30b25b7")`
 *
 * @param after The after parameter provided
 * @param validKeys The keys or compound keys that are valid cursor targets
 */
export function parseCursor<T extends object>(
    after: string,
    validKeys: (keyof T | CursorKey<T>)[]
): Cursor<T> {
    const [keyStr, value] = base64decode(after).split(':', 2)
    const compoundKey = keyStr.split(',')
    if (value === undefined || !validKeys.some(validKey => isEqual(compoundKey, validKey))) {
        throw new Error('Invalid cursor')
    }
    return { key: compoundKey as (keyof T)[], value }
}

/**
 * PostgreSQL's `array_agg()` returns an array with a `null` element if the input set was empty.
 */
export const isNullArray = (arr: [null] | unknown[]): arr is [null] => arr.length === 1 && arr[0] === null

export type NullFields<T> = { [K in keyof T]: null }

/**
 * Map the nodes in a GraphQL Relay Connection.
 */
export const mapConnectionNodes = <T, R>(connection: Connection<T>, fn: (node: T) => R): Connection<R> => ({
    ...connection,
    edges: connection.edges.map(edge => ({ ...edge, node: fn(edge.node) })),
})

export function asError(value: unknown): Error {
    if (value instanceof Error) {
        return value
    }
    if (typeof value === 'string') {
        return new Error(value)
    }
    return new Error()
}

export function dataOrErrors<D>(result: ExecutionResult<D>): D {
    if (result.errors) {
        throw result.errors[0].originalError ?? result.errors[0]
    }
    return result.data!
}

// eslint-disable-next-line @typescript-eslint/ban-types
export const logDuration = <P extends any[], R>(tag: string, fn: (...args: P) => Promise<R>) => async (
    ...args: P
): Promise<R> => {
    const start = Date.now()
    console.log(tag, 'starting')
    const result = await fn(...args)
    console.log(tag, `${((Date.now() - start) / 1000).toFixed(3)}s`)
    return result
}
