import 'source-map-support/register'

import express, { Request, Response, NextFunction } from 'express'
import { Pool } from 'pg'
import * as path from 'path'
import { createGraphQLHandler, createGraphQLHTTPHandler } from './routes/graphql'
import morgan from 'morgan'
import { createRepoUploadRouter } from './routes/git'
import { Server } from 'http'
import { AddressInfo } from 'net'
import { createRestRouter } from './routes/rest'
import compression from 'compression'
import basicAuth from 'express-basic-auth'
import { initTracerFromEnv } from 'jaeger-client'
import { Tracer } from 'opentracing'
import opentracingMiddleware from 'express-opentracing'
import bodyParser from 'body-parser'

const repoRoot = path.resolve(process.env.REPO_ROOT || path.resolve(process.cwd(), 'repos'))
const port = (process.env.PORT && parseInt(process.env.PORT, 10)) || 4040
const basicAuthUsers = process.env.BASIC_AUTH_USERS && JSON.parse(process.env.BASIC_AUTH_USERS)

async function main(): Promise<void> {
    const dbPool = new Pool()
    const tracer: Tracer = initTracerFromEnv({ serviceName: 'olfaction-api' }, {})

    const app = express()

    app.set('etag', true)

    app.use(opentracingMiddleware({ tracer }))

    app.use(compression())

    app.use(bodyParser.json({ limit: '2GB' }))

    app.use(morgan('dev', { immediate: false }))

    if (basicAuthUsers) {
        app.use(basicAuth({ users: basicAuthUsers, challenge: true, realm: 'olfaction' }))
    }

    const graphQLHandler = createGraphQLHandler({ dbPool, repoRoot })
    app.use('/graphql', createGraphQLHTTPHandler({ ...graphQLHandler, dbPool, repoRoot }))

    app.use(createRepoUploadRouter({ repoRoot }))

    app.use(createRestRouter({ repoRoot, dbPool, graphQLHandler }))

    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
        console.error(err)
        res.status(err.status ?? 500).json({ ...err, message: err.message })
    })

    const server = await new Promise<Server>((resolve, reject) => {
        let server: Server
        // eslint-disable-next-line prefer-const
        server = app.listen(port, err => (err ? reject(err) : resolve(server)))
    })

    console.log(`Listening on port ${(server.address() as AddressInfo).port}`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
