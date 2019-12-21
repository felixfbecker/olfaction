# 3. Are files that contain at least one code smell changed more often than files without code smells?

param(
)

$body = (@{
    query = '
        {
            repositories {
                edges {
                    node {
                        commits(grep: "(closes?|fix(es)?\s+#?\d+") {
                            edges {
                                node {
                                    affectedFiles {
                                        codeSmells {
                                            # Query 1 to check if there is at least one code smell
                                            edges(first: 1) {
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
    '
    variables = @{}
} | ConvertTo-Json)

Invoke-RestMethod -Body $body |
    ForEach-Object { $_.repositories.edges } |
    ForEach-Object { $_.node.commits.edges } |
    ForEach-Object {
        $groupedByHasCodeSmell = $_.affectedFiles | Group-Object -Property { $_.codeSmells.edges.Length -gt 0 }
        [pscustomobject]@{
            affectedFilesWithCodeSmell = $groupedByHasCodeSmell[$true]
            affectedFilesWithoutCodeSmell = $groupedByHasCodeSmell[$false]
        }
    } |
    ForEach-Object {
        [pscustomobject]@{
            affectedFilesWithCodeSmell = $_.affectedFilesWithCodeSmell.Count
            affectedFilesWithoutCodeSmell = $_.affectedFilesWithoutCodeSmells.Count
        }
    } |
    Measure-Object -AllStats -Property affectedFiles*
