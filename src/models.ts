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

export interface CodeSmell {
    id: UUID
    message: string
    locations: Location[]
    lifespan: UUID
    lifespanIndex: number
    commit: SHA
}

export interface File {
    path: string
}

export interface CodeSmellLifespanSpec {
    lifespan: UUID
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
