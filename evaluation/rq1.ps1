
# 1. How long is the lifespan of specific kinds of code smells?

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Analysis,

    [Uri] $ServerUrl = [Uri]::new("http://localhost:4040"),
    [pscredential] $Credential
)

$body = (@{
    query = '
        query($analysis: String!) {
            analysis(name: $analysis) {
                analyzedRepositories {
                    edges {
                        node {
                            # Get first and last commit date to calculate percentage of the total project age
                            commits {
                                edges {
                                    node {
                                        author {
                                            date
                                        }
                                    }
                                }
                            }
                            codeSmellLifespans {
                                edges {
                                    node {
                                        kind
                                        duration
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    '
    variables = @{
        analysis = $Analysis
    }
} | ConvertTo-Json)
Write-Verbose "Body: $body"

$duration = Measure-Command {
    $result = Invoke-RestMethod -Method POST -Uri ([Uri]::new($ServerUrl, "/graphql")) -Body $body -ContentType 'application/json' -Credential $Credential -AllowUnencryptedAuthentication
}
Write-Verbose "Got result after $duration"
if ($result.PSObject.Properties['errors'] -and $result.errors) {
    throw ($result.errors | ConvertTo-Json -Depth 100)
}
$result.data.analysis.analyzedRepositories.edges |
    ForEach-Object {
        $repo = $_.node
        $headCommitDate = $repo.commits.edges[0].node.author.date
        $initialCommitDate = $repo.commits.edges[$repo.commits.edges.Length - 1].node.author.date
        $projectAge = $headCommitDate - $initialCommitDate

        $repo.codeSmellLifespans.edges | ForEach-Object {
            [pscustomobject]@{
                Kind = $_.node.kind
                Age = [System.Xml.XmlConvert]::ToTimeSpan($_.node.duration) / $projectAge
            }
        }
    }
    # Group-Object -Property Kind |
    # ForEach-Object {
    #     $measure = $_.Group | Measure-Object -AllStats -Property Age
    #     Add-Member -MemberType NoteProperty -Name Kind -Value $_.Name -InputObject $measure
    #     $measure
    # }
