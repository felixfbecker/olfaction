import { RepoRootSpec } from '../models'
import cgi from 'cgi'
import { Router } from 'express'
import { wrap } from 'async-middleware'
import * as git from '../git'

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
        args: ['http-backend'],
        mountPoint: '/git',
        env: gitCGIEnv,
        stderr: process.stderr,
    })

    router.use<{ repository: string }>(
        '/:repository',
        wrap(async (req, res, next) => {
            const repository = req.params.repository
            try {
                await git.validateRepository({ repository, repoRoot })
            } catch {
                console.log('Initializing new repository', repository)
                await git.init({ repository, repoRoot })
            }
            handleGitReq(req, res, next)
        })
    )

    return router
}
