import { RepoRootSpec, RepoSpec } from '../models'
import cgi from 'cgi'
import { Router } from 'express'
import { wrap } from 'async-middleware'
import * as git from '../git'
import * as fs from 'mz/fs'
import { tmpdir } from 'os'
import * as path from 'path'
import * as uuid from 'uuid'
import { pipeline as _pipeline } from 'stream'
import { promisify } from 'util'
import HttpStatus from 'http-status-codes'
const pipeline = promisify(_pipeline)

interface GitCGIEnv {
    GIT_PROJECT_ROOT?: string
    GIT_HTTP_EXPORT_ALL?: '1'
}

export const createRepoUploadRouter = ({ repoRoot }: RepoRootSpec): Router => {
    const router = Router()

    const gitCGIEnv: GitCGIEnv = {
        GIT_PROJECT_ROOT: repoRoot,
        GIT_HTTP_EXPORT_ALL: '1',
    }

    const handleGitReq = cgi('git', {
        mountPoint: '/repositories',
        args: ['http-backend'],
        env: gitCGIEnv,
        stderr: process.stderr,
    })

    async function initRepoIfNotExists({ repository, repoRoot }: RepoRootSpec & RepoSpec): Promise<boolean> {
        try {
            await git.checkRepositoryExists({ repository, repoRoot })
            return true
        } catch {
            console.log('Initializing new repository', repository)
            await git.init({ repository, repoRoot })
            return false
        }
    }

    router.all<{ repository: string }>(
        '/repositories/:repository.git/*',
        wrap(async (req, res, next) => {
            const { repository } = req.params
            git.validateRepositoryName({ repository })
            await initRepoIfNotExists({ repoRoot, repository })
            handleGitReq(req, res, next)
        })
    )

    router.post<{ repository: string }>(
        '/repositories/:repository.bundle',
        wrap(async (req, res) => {
            const { repository } = req.params
            git.validateRepositoryName({ repository })
            const tmpFile = path.join(tmpdir(), uuid.v4())
            const outStream = fs.createWriteStream(tmpFile)
            await pipeline(req, outStream)
            try {
                const existed = await initRepoIfNotExists({ repoRoot, repository })
                res.status(existed ? HttpStatus.OK : HttpStatus.CREATED)
                await git.unbundle({ repoRoot, repository, bundlePath: tmpFile })
            } finally {
                await fs.unlink(tmpFile)
            }
            res.end()
        })
    )

    return router
}
