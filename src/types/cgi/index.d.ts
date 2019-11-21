declare module 'cgi' {
    import { NextFunction } from 'connect'
    import { RequestListener, IncomingMessage, ServerResponse } from 'http'

    interface Options {
        /** The 'cgi' handler will take effect when the req.url begins with "mountPoint" */
        mountPoint?: string
        /** Any additional variables to insert into the CGI script's Environment */
        env?: object
        /** Set to 'true' if the CGI script is an NPH script */
        nph?: boolean
        /** Set to a `Stream` instance if you want to log stderr of the CGI script somewhere */
        stderr?: NodeJS.WriteStream
        /** A list of arguments for the cgi bin to be used by spawn */
        args?: string[]
    }
    function cgi(
        scriptPath: string,
        options?: Options
    ): (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void
    export = cgi
}
