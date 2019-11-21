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

export interface CodeSmell {
    id: UUID
    kind: string
    message: string
    predecessor: UUID | null
    locations: Location[]
    commit: SHA
    repository: string
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
