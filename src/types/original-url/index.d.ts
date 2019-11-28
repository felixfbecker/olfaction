declare module 'original-url' {
    import { IncomingMessage } from 'http'
    function originalUrl(req: IncomingMessage): string
    export = originalUrl
}
