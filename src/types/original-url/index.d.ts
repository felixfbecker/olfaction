declare module 'original-url' {
    import { IncomingMessage } from 'http'
    import { Url } from 'url'
    interface OriginalUrl extends Url {
        full: string
    }
    function originalUrl(req: IncomingMessage): OriginalUrl
    export = originalUrl
}
