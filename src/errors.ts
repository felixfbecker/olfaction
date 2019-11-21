import { UUID, RepoSpec, CommitSpec } from './models'
import * as HttpStatus from 'http-status-codes'

export class CodeSmellNotFoundError extends Error {
    public readonly name = 'CodeSmellNotFoundError'
    constructor(public id: UUID) {
        super(`Could not find code smell with id ${id}`)
    }
}

export class UnknownCommitError extends Error {
    constructor({ repository, commit }: RepoSpec & CommitSpec) {
        super(
            `Commit ${commit} of repository ${repository} is not known to server. Please make sure the commit was pushed with \`git push\` first.`
        )
    }
}
export class UnknownRepositoryError extends Error {
    readonly name = 'UnknownRepositoryError'
    readonly status = HttpStatus.NOT_FOUND
    constructor({ repository }: RepoSpec) {
        super(
            `Repository ${repository} is not known to server. Please make sure the repository was pushed with \`git push\` first.`
        )
    }
}
