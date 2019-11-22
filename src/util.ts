import { Client } from 'pg'
import sql from 'sql-template-strings'

export function groupBy<K, V>(items: Iterable<V>, by: (value: V) => K): Map<K, V> {
    const map = new Map<K, V>()
    for (const item of items) {
        map.set(by(item), item)
    }
    return map
}

export async function transaction<T>(db: Client, fn: () => Promise<T>): Promise<T> {
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

interface Cursor<T> {
    /** The attribute that the cursor refers to */
    key: keyof T
    /** The serialized value the cursor points to (may need to be coerced). */
    value: string
}

/**
 * Parses a string cursor as used in the olfaction API.
 * A cursor is composed of a target attribute, a colon, and the value of the property, all Base64 encoded.
 * E.g. base64encode("id:6fcc41f6-772d-4601-b940-6012b30b25b7")
 *
 * @param after The after parameter provided
 * @param validKeys The keys that are valid cursor targets
 */
export function parseCursor<T extends object>(after: string, validKeys: ReadonlySet<keyof T>): Cursor<T> {
    const [key, value] = base64decode(after).split(':', 2)
    if (value === undefined || !validKeys.has(key as keyof T)) {
        throw new Error('Invalid cursor')
    }
    return { key: key as keyof T, value }
}

/**
 * PostgreSQL's `array_agg()` returns an array with a `null` element if the input set was empty.
 */
export const isNullArray = (arr: [null] | unknown[]): arr is [null] => arr.length === 1 && arr[0] === null

export type NullFields<T> = { [K in keyof T]: null }
