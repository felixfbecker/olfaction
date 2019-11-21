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

export type NullFields<T> = { [K in keyof T]: null }
