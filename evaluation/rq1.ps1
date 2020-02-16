<#
.SYNOPSIS
    Answers RQ1: How long is the lifespan of specific kinds of code smells?

.OUTPUTS
    Outputs objects with properties `Kind` and `Age` (float between 0..1).

    To aggregate output, pipe the output to:

        Group-Object -Property Kind |
        ForEach-Object {
        $_.Group |
            Measure-Object -AllStats -Property Age |
            Add-Member -MemberType NoteProperty -Name Kind -Value $_.Name -PassThru
        }

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
    [string] $Analysis = "seed",
    [Uri] $ServerUrl = [Uri]::new("http://localhost"),
    [pscredential] $Credential
)

Set-StrictMode -Version Latest

$apiParams = @{
    Method = 'POST'
    Uri = ([Uri]::new($ServerUrl, "/graphql"))
    ContentType = 'application/json'
    Credential = $Credential
    AllowUnencryptedAuthentication = $true
}

$repositoriesQuery = '
    query($analysis: String!) {
        analysis(name: $analysis) {
            analyzedRepositories {
                edges {
                    node {
                        name
                    }
                }
            }
        }
    }
'
$commitsQuery = '
    query($repo: String!) {
        repository(name: $repo) {
            # Get first and last commit date to calculate percentage of the total project age
            headCommit: commits(first: 1) {
                edges {
                    node {
                        author {
                            date
                        }
                    }
                }
            }
            initialCommit: commits(last: 1) {
                edges {
                    node {
                        author {
                            date
                        }
                    }
                }
            }
        }
    }
'
$lifespanQuery = '
    query($repo: String!, $afterLifespan: String) {
        repository(name: $repo) {
            codeSmellLifespans(first: 700, after: $afterLifespan) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                edges {
                    node {
                        kind
                        duration
                    }
                }
            }
        }
    }
'

$script:requests = 0

# Get repos
Invoke-RestMethod @apiParams -Body (ConvertTo-Json -InputObject @{
    query = $repositoriesQuery
    variables = @{ analysis = $Analysis }
}) |
    ForEach-Object { $_.data.analysis.analyzedRepositories.edges } |
    ForEach-Object { $_.node.name } |
    ForEach-Object {
        $repoName = $_
        Write-Verbose "RQ1 Repo $repoName"

        # Get head and initial commit for project age
        Write-Verbose "Getting commits"
        $commitsResult = Invoke-RestMethod @apiParams -Body (ConvertTo-Json -InputObject @{
            query = $commitsQuery
            variables = @{ repo = $repoName }
        })
        if ($commitsResult.PSObject.Properties['errors'] -and $commitsResult.errors) {
            Write-Error ($commitsResult.errors | ConvertTo-Json -Depth 100 -Compress)
        }
        Write-Verbose "Got commits"

        # Calculate total project age
        $headCommitDate = $commitsResult.data.repository.headCommit.edges[0].node.author.date
        $initialCommitDate = $commitsResult.data.repository.initialCommit.edges[0].node.author.date
        $projectAge = $headCommitDate - $initialCommitDate

        &{
            # Paginate lifespans
            $body = [pscustomobject]@{
                query     = $lifespanQuery
                variables = [pscustomobject]@{
                    repo = $repoName
                    afterLifespan = $null
                }
            }
            while ($true) {
                Write-Verbose "RQ1 $repoName Request $($script:requests)"
                $result = Invoke-RestMethod @apiParams -Body (ConvertTo-Json -InputObject $body -Compress)

                $script:requests++

                if ($result.PSObject.Properties['errors'] -and $result.errors) {
                    Write-Error ($result.errors | ConvertTo-Json -Depth 100 -Compress)
                }

                $lifespanConnection = $result.data.repository.codeSmellLifespans

                # Process lifespans
                $lifespanConnection.edges
                Write-Verbose "RQ1 $repoName $($lifespanConnection.edges.length) lifespans"

                if ($lifespanConnection.pageInfo.hasNextPage) {
                    $body.variables.afterLifespan = $lifespanConnection.pageInfo.endCursor
                    Write-Verbose "Next code smell lifespan page after $($body.variables.afterLifespan)"
                    continue
                }
                Write-Verbose "No next page"
                break
            }
        } |
            Where-Object { $null -ne $_.node.duration } |
            ForEach-Object {
                [pscustomobject]@{
                    Kind = $_.node.kind
                    Age  = [System.Xml.XmlConvert]::ToTimeSpan($_.node.duration) / $projectAge
                }
            }
    }

Write-Verbose "$script:requests requests made"
