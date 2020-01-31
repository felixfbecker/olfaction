import { Tracer, Span } from 'opentracing'
import { ERROR } from 'opentracing/lib/ext/tags'

export interface TracerContext {
    tracer: Tracer
}

export interface ParentSpanContext {
    span?: Span
}

// eslint-disable-next-line @typescript-eslint/ban-types
export const trace = async <R>(
    childOf: Span | undefined = new Span(),
    operationName: string,
    fn: (span: Span) => Promise<R> | R
): Promise<R> => {
    const span = childOf.tracer().startSpan(operationName, { childOf })
    try {
        return await fn(span)
    } catch (err) {
        span.setTag(ERROR, 'true')
        span.log({ event: ERROR, 'error.object': err, stack: err.stack, message: err.message })
        throw err
    } finally {
        span.finish()
    }
}
