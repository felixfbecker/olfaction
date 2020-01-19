# 3. Are files that contain at least one code smell changed more often than files without code smells?

[CmdletBinding()]
param(
    [Uri] $ServerUrl = [Uri]::new("http://localhost:4040")
)

$body = (@{
    query = '
        query($messagePattern: String!) {
            repositories {
                edges {
                    node {
                        commits(grep: $messagePattern) {
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
    '
    variables = @{
        # Only consider commits that reference an issue
        messagePattern = "(fix(es)?|clos(es)?|issue)\s*#[0-9]+"
    }
} | ConvertTo-Json)

$result = Invoke-RestMethod -Method POST -Uri ([Uri]::new($ServerUrl, "/graphql")) -Body $body -ContentType 'application/json'
if ($result.PSObject.Properties['errors'] -and $result.errors) {
    throw ($result.errors | ConvertTo-Json -Depth 100)
}
Write-Verbose "Got result"
$result.data.repositories.edges |
    ForEach-Object { $_.node.commits.edges } |
    ForEach-Object {
        $commit = $_.node
        # We consider any file change to a file that had a code smell in one of the commit's parents
        $grouped = $commit.combinedFileDifferences.edges |
            # File needs to have at least one base file
            Where-Object { $_.node.baseFiles } |
            Group-Object -AsHashTable -Property {
                @($_.node.baseFiles | ForEach-Object { $_.codeSmells.edges }).Count -gt 0
            }
        if ($grouped) {
            [pscustomobject]@{
                Commit = $commit.oid
                FileChangesWithCodeSmell    = if ($grouped.ContainsKey($true)) { $grouped[$true].Count } else { 0 }
                FileChangesWithoutCodeSmell = if ($grouped.ContainsKey($false)) { $grouped[$false].Count } else { 0 }
            }
        }
    } |
    Measure-Object -AllStats -Property FileChanges* |
    Select-Object -Property Property,Sum,Average,StandardDeviation,Minimum,Maximum
