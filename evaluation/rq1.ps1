
# 1. How long is the lifespan of specific kinds of code smells?

param(
    [string] $Kind
)

$body = (@{
    query = '
        {
            repositories {
                edges {
                    node {
                        # Get first and last commit date to calculate percentage of the total project age
                        initialCommit: commits(last: 1) {
                            edges {
                                node {
                                    author {
                                        date
                                    }
                                }
                            }
                        }
                        headCommit: commits(first: 1) {
                            edges {
                                node {
                                    author {
                                        date
                                    }
                                }
                            }
                        }
                        codeSmellLifespans(kind: $kind) {
                            edges {
                                node {
                                    duration
                                }
                            }
                        }
                    }
                }
            }
        }
    '
    variables = @{
        repository = $Repository
        kind = $Kind
    }
} | ConvertTo-Json)

Invoke-RestMethod -Body $body |
    ForEach-Object { $_.data.repositories.edges } |
    ForEach-Object {
        $repo = $_
        $headCommitDate = $repo.headCommit.edges[0].node.author.date
        $initialCommitDate = $repo.initialCommit.edges[0].node.author.date
        $projectAge = $headCommitDate - $initialCommitDate

        $repo.codeSmellLifespans.edges |
            ForEach-Object { [System.Xml.XmlConvert]::ToTimeSpan($_.node.duration) } |
            ForEach-Object { $_ / $projectAge }
    } |
    Measure-Object -AllStats
