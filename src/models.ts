export type UUID = string
export type GitObjectID = string

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
    oid: GitObjectID
    author: Signature
    committer: Signature
    message: string
}

export enum ChangeKind {
    Added = 'A',
    Copied = 'C',
    Modified = 'M',
    Deleted = 'D',
    Renamed = 'R',
    TypeChanged = 'T',
}

/**
 * A file difference as in [Git's combined diff format](https://git-scm.com/docs/git-diff#_combined_diff_format).
 */
export interface CombinedFileDifference {
    /**
     * The kind of change detected for each base revision.
     */
    changeKinds: ChangeKind[]

    /**
     * The file paths at the base revisions.
     * Contains `null` if the file does not exist in that base revision.
     */
    basePaths: (string | null)[]

    /**
     * The file path at the head revision.
     * `null` if the file does not exist in the head revision.
     */
    headPath: string | null
}

export interface CodeSmell {
    id: UUID
    message: string
    locations: Location[]
    lifespan: UUID
    ordinal: number
    commit: GitObjectID
}

export interface CodeSmellInput {
    lifespan: UUID
    ordinal: number
    kind: string
    message: string | null
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
    commit: GitObjectID
}

export interface RevisionSpec {
    revision: string
}

export interface FileSpec {
    file: string
}

export interface RepoRootSpec {
    repoRoot: string
}
