export class AbortError extends Error {
    public readonly name = 'AbortError'
}

export function throwIfAbortError(err: unknown): void {
    if (err instanceof Error && err.name === 'AbortError') {
        throw err
    }
}
