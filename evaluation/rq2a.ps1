<#
.SYNOPSIS
    Answers RQ2: How scattered are code smells in each commit over time?

.OUTPUTS
    Outputs the CommitEdges with files and code smell locations, as needed for the computation.

    To store it in a newline-delimited JSON file, pipe the output to:

        ForEach-Object node |
        ForEach-Object { $_ | ConvertTo-Json -Depth 100 -Compress } |
        Out-File ./rq2_data.jsonnd

.PARAMETER ServerUrl
    Optional URL of the server. Defaults to http://localhost.

.PARAMETER Analysis
    Analysis to gather data from. Defaults to "seed".

.PARAMETER Credential
    Optional HTTP basic auth credentials to use.

.PARAMETER Verbose
    Enable logging.
#>

[cmdletbinding()]
param(
    [Uri] $ServerUrl = [Uri]::new("http://localhost"),
    [string] $Analysis = 'seed',
    [pscredential] $Credential
)


$query = '
    query($analysis: String!, $afterRepo: String, $afterCommit: String, $commitsFirst: Int) {
        analysis(name: $analysis) {
            analyzedRepositories(first: 1, after: $afterRepo) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                edges {
                    node {
                        name
                        commits(after: $afterCommit, first: $commitsFirst) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            edges {
                                node {
                                    oid
                                    # Get all files to determine breadth of software
                                    files {
                                        edges {
                                            node {
                                                path
                                            }
                                        }
                                    }
                                    codeSmells {
                                        edges {
                                            node {
                                                lifespan {
                                                    kind
                                                }
                                                locations {
                                                    file {
                                                        path
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
    # Paginate commits and repositories
    $body = [pscustomobject]@{
        query = $query
        variables = [pscustomobject]@{
            analysis = $Analysis
            afterRepo = $null
            afterCommit = $null
            commitsFirst = 10
        }
    }
    while ($true) {
        Write-Verbose "RQ2 Request $($script:requests)"
        $result = Invoke-RestMethod `
            -Method POST `
            -Uri ([Uri]::new($ServerUrl, "/graphql")) `
            -Body (ConvertTo-Json -InputObject $body -Compress) `
            -ContentType 'application/json' `
            -Credential $Credential `
            -AllowUnencryptedAuthentication
        Write-Verbose "Got result"

        $script:requests++

        if ($result.PSObject.Properties['errors'] -and $result.errors) {
            throw ($result.errors | ConvertTo-Json -Depth 100)
        }

        $repoConnection = $result.data.analysis.analyzedRepositories
        Write-Verbose "RQ2 repo $($repoConnection.edges[0].node.name)"
        $commitConnection = $repoConnection.edges[0].node.commits

        # Adjust pagination of commits based on how many files and code smells are in the repo
        $lastCommit = $commitConnection.edges[$commitConnection.edges.Count - 1].node
        Write-Verbose "$($lastCommit.files.edges.Count) files"
        Write-Verbose "$($lastCommit.codeSmells.edges.Count) code smells"
        $countSum = $lastCommit.files.edges.Count + $lastCommit.codeSmells.edges.Count
        $body.variables.commitsFirst = if ($countSum -ne 0) { [int][math]::max(1, [math]::min(100, 150000 / $countSum)) } else { 10 }
        Write-Verbose "Adjusting page size to $($body.variables.commitsFirst) commits"

        # Process commits
        $commitConnection.edges

        if ($commitConnection.pageInfo.hasNextPage) {
            $body.variables.afterCommit = $commitConnection.pageInfo.endCursor
            if (-not $commitConnection.pageInfo.endCursor) {
                throw "Invalid cursor"
            }
            Write-Verbose "Next commit page after $($body.variables.afterCommit)"
            continue
        }
        if ($repoConnection.pageInfo.hasNextPage) {
            $body.variables.afterRepo = $repoConnection.pageInfo.endCursor
            $body.variables.afterCommit = $null
            Write-Verbose "Next repository page after $($body.variables.afterRepo)"
            continue
        }
        Write-Verbose "No next page"
        break
    }
}
Write-Verbose "$script:requests requests made"
