declare module 'http' {
    import { Span } from 'opentracing'
    interface IncomingMessage {
        span?: Span
    }
}
