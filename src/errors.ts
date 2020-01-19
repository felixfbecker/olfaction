import { RepoSpec, CommitSpec, CodeSmellLifespanSpec, CodeSmellSpec, CodeSmell, RevisionSpec } from './models'
import * as HttpStatus from 'http-status-codes'

export class UnknownCodeSmellLifespanError extends Error {
    public readonly name = 'UnknownCodeSmellLifespanError'
    public readonly status = HttpStatus.NOT_FOUND

    constructor({ lifespan }: CodeSmellLifespanSpec) {
        super(`Could not find code smell lifespan with id ${lifespan}`)
    }
}

export class UnknownCodeSmellError extends Error {
    public readonly name: 'UnknownCodeSmellError'
    public readonly status: typeof HttpStatus.NOT_FOUND

    constructor(spec: CodeSmellSpec | (CodeSmellLifespanSpec & Pick<CodeSmell, 'ordinal'>)) {
        if ('codeSmell' in spec) {
            super(`Could not find code smell with id ${spec.codeSmell}`)
        } else {
            super(`Could not find code smell in lifespan '${spec.lifespan}' at ordinal ${spec.ordinal}`)
        }
        this.name = 'UnknownCodeSmellError'
        this.status = HttpStatus.NOT_FOUND
    }
}

export class UnknownRevisionError extends Error {
    public readonly status = HttpStatus.NOT_FOUND
    constructor({ repository, revision }: RepoSpec & RevisionSpec) {
        super(`Revision ${revision} of repository ${repository} is not known to the server.`)
    }
}

export class UnknownCommitError extends Error {
    public readonly status = HttpStatus.NOT_FOUND
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
