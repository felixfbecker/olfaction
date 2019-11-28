import { RepoSpec, CommitSpec, CodeSmellLifespanSpec, CodeSmellSpec, CodeSmell } from './models'
import * as HttpStatus from 'http-status-codes'

export class UnknownCodeSmellLifespanError extends Error {
    public readonly name = 'UnknownCodeSmellLifespanError'
    constructor({ lifespan }: CodeSmellLifespanSpec) {
        super(`Could not find code smell lifespan with id ${lifespan}`)
    }
}

export class UnknownCodeSmellError extends Error {
    public readonly name: 'UnknownCodeSmellError'
    constructor(spec: CodeSmellSpec | (CodeSmellLifespanSpec & Pick<CodeSmell, 'lifespanIndex'>)) {
        if ('codeSmell' in spec) {
            super(`Could not find code smell with id ${spec.codeSmell}`)
        } else {
            super(
                `Could not find code smell with lifespan ID ${spec.lifespan} and index ${spec.lifespanIndex}`
            )
        }
        this.name = 'UnknownCodeSmellError'
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
