<#
.SYNOPSIS
    Answers RQ3: Are files that contain at least one code smell changed more often than files without code smells?

.OUTPUTS
    Outputs results as objects with properties Commit (string), FileChangesWithCodeSmell (int) and FileChangesWithoutCodeSmell (int).

    To aggregate results, pipe output into:
        Measure-Object -AllStats -Property FileChanges* |
        Select-Object -Property Property, Sum, Average, StandardDeviation, Minimum, Maximum

.PARAMETER ServerUrl
    Optional URL of the server. Defaults to http://localhost.

.PARAMETER Analysis
    Analysis to gather data from. Defaults to "seed".

.PARAMETER Credential
    Optional HTTP basic auth credentials to use.

.PARAMETER Verbose
    Enable logging.
#>

[CmdletBinding()]
param(
    [Uri] $ServerUrl = [Uri]::new("http://localhost"),
    [string] $Analysis = 'seed',
    [pscredential] $Credential
)

Set-StrictMode -Version latest

$query = '
    query($analysis: String!, $messagePattern: String, $afterRepo: String, $afterCommit: String) {
        analysis(name: $analysis) {
            analyzedRepositories(first: 1, after: $afterRepo) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                edges {
                    node {
                        name
                        commits(messagePattern: $messagePattern, first: 1000, after: $afterCommit) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            edges {
                                node {
                                    oid
                                    combinedFileDifferences {
                                        edges {
                                            node {
                                                # Query file BEFORE the change
                                                baseFiles {
                                                    codeSmells(first: 1) {
                                                        # Query 1 to check if there is at least one code smell
                                                        edges {
                                                            node {
                                                                id
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
'

$script:requests = 0
&{
    $body = [pscustomobject]@{
        query = $query
        variables = [pscustomobject]@{
            # Only consider commits that reference an issue
            messagePattern = "(fix(es)?|closes?)\s*(issue)?\s*#[0-9]+"
            analysis = $Analysis
            afterCommit = $null
            afterRepo = $null
        }
    }
    while ($true) {
        Write-Verbose "RQ3 Request $($script:requests)"
        $result = Invoke-RestMethod `
            -Method POST `
            -Uri ([Uri]::new($ServerUrl, "/graphql")) `
            -Body (ConvertTo-Json -InputObject $body -Compress) `
            -ContentType 'application/json' `
            -Credential $Credential `
            -AllowUnencryptedAuthentication
        Write-Verbose "RQ3 Got result"

        $script:requests++

        if ($result.PSObject.Properties['errors'] -and $result.errors) {
            throw ($result.errors[0] | ConvertTo-Json -Depth 100)
        }
        $repoConnection = $result.data.analysis.analyzedRepositories

        # Process commits
        Write-Verbose "RQ3 $($repoConnection.edges[0].node.name)"
        Write-Verbose "RQ3 $($repoConnection.edges[0].node.commits.edges.Count) commits"
        $repoConnection.edges[0].node.commits.edges

        if ($repoConnection.edges[0].node.commits.pageInfo.hasNextPage) {
            $body.variables.afterCommit = $repoConnection.edges[0].node.commits.pageInfo.endCursor
            Write-Verbose "RQ3 Next commit page after $($body.variables.afterCommit)"
            continue
        }
        if ($repoConnection.pageInfo.hasNextPage) {
            $body.variables.afterRepo = $repoConnection.pageInfo.endCursor
            $body.variables.afterCommit = $null
            Write-Verbose "RQ3 Next repository page after $($body.variables.afterRepo)"
            continue
        }
        Write-Verbose "No next page"
        break
    }
} |
    ForEach-Object {
        $commit = $_.node
        # We consider any file change to a file that had a code smell in one of the commit's parents
        $grouped = $commit.combinedFileDifferences.edges |
            # File needs to have at least one base file
            Where-Object { $_.node.baseFiles } |
            Group-Object -AsHashTable -Property {
                @($_.node.baseFiles | Where-Object { $null -ne $_ } | ForEach-Object { $_.codeSmells.edges }).Count -gt 0
            }
        if ($grouped) {
            [pscustomobject]@{
                Commit = $commit.oid
                FileChangesWithCodeSmell    = if ($grouped.ContainsKey($true)) { $grouped[$true].Count } else { 0 }
                FileChangesWithoutCodeSmell = if ($grouped.ContainsKey($false)) { $grouped[$false].Count } else { 0 }
            }
        }
    }

Write-Verbose "$script:requests requests made"
