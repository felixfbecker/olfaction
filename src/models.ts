export type UUID = string
export type SHA = string

export interface Range {
    start: Position
    end: Position
}

export interface Position {
    line: number
    character: number
}

export interface Location {
    file: string
    range: Range
}

export interface CodeSmellLifespan {
    id: UUID
    kind: string
    repository: string
}

export interface Signature {
    name: string
    email: string
    /** Strict ISO date string (including timezone) */
    date: string
}

export interface Commit {
    sha: SHA
    author: Signature
    committer: Signature
    message: string
}

export interface CodeSmell {
    id: UUID
    message: string
    locations: Location[]
    lifespan: UUID
    ordinal: number
    commit: SHA
}

export interface CodeSmellInput {
    lifespan: UUID
    ordinal: number
    kind: string
    message: string
    locations: Location[]
}

export interface File {
    path: string
}

export interface CodeSmellLifespanSpec {
    lifespan: UUID
}

export interface CodeSmellSpec {
    codeSmell: UUID
}

export interface RepoSpec {
    repository: string
}

export interface CommitSpec {
    commit: SHA
}

export interface FileSpec {
    file: string
}

export interface RepoRootSpec {
    repoRoot: string
}
