declare module 'express-opentracing' {
    import { Tracer } from 'opentracing'
    import { IncomingMessage, ServerResponse } from 'http'
    export default function middleware(options: {
        tracer: Tracer
    }): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void
}
