import 'source-map-support/register'

import express, { Request, Response, NextFunction } from 'express'
import { Client } from 'pg'
import * as path from 'path'
import { createGraphQLHandler, createGraphQLHTTPHandler } from './routes/graphql'
import morgan from 'morgan'
import { createRepoUploadRouter } from './routes/git'
import { Server } from 'http'
import { AddressInfo } from 'net'
import { createRestRouter } from './routes/rest'

const repoRoot = path.resolve(process.env.REPO_ROOT || 'repos')
const port = (process.env.PORT && parseInt(process.env.PORT, 10)) || 4040

async function main(): Promise<void> {
    const app = express()

    const db = new Client()
    await db.connect()

    app.use(morgan('dev', { immediate: true }))

    app.use('/git', createRepoUploadRouter({ repoRoot }))

    const graphQLHandler = createGraphQLHandler({ db, repoRoot })

    app.use('/graphql', createGraphQLHTTPHandler({ ...graphQLHandler, db, repoRoot }))

    app.use('/rest', createRestRouter({ repoRoot, db, graphQLHandler }))

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
