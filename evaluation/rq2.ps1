#Requires -Version 7.0

# 2. How scattered are code smells in each commit over time?

[cmdletbinding()]
param(
    [Uri] $ServerUrl = [Uri]::new("http://localhost:4040"),

    [Parameter(Mandatory)]
    $Analysis,

    [pscredential] $Credential
)


$body = (@{
    query = '
        query($analysis: String!) {
            analysis(name: $analysis) {
                analyzedRepositories {
                    edges {
                        node {
                            commits {
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
    variables = @{
        analysis = $Analysis
    }
} | ConvertTo-Json)

$measure = Measure-Command {
    $result = Invoke-RestMethod -Method POST -Uri ([Uri]::new($ServerUrl, "/graphql")) -Body $body -ContentType 'application/json' -Credential $Credential -AllowUnencryptedAuthentication
}
Write-Verbose "Got result after $measure"
if ($result.PSObject.Properties['errors'] -and $result.errors) {
    throw ($result.errors | ConvertTo-Json -Depth 100)
}
$result.data.analysis.analyzedRepositories.edges |
    ForEach-Object { $_.node.commits.edges } |
    ForEach-Object -Parallel {
        Import-Module $using:PSScriptRoot/directory_distance.psm1

        $commit = $_.node
        Write-Verbose "Commit $($commit.oid)"
        Write-Verbose "$($commit.files.edges.Count) files"
        # Calculate breadth of software at this commit
        $breadth = (Measure-PairwiseDirectoryDistances -Paths ($commit.files.edges | ForEach-Object { $_.node.path }) | Measure-Object -Maximum).Maximum
        Write-Verbose "Maximum breadth is $breadth"
        Write-Verbose "Going through $($commit.codeSmells.edges.Count) code smells"
        $commit.codeSmells.edges |
            ForEach-Object { $_.node } |
            # Group all code smells by kind within one commit
            Group-Object -Property { $_.lifespan.kind } |
            ForEach-Object {
                $kind = $_.Name
                $filePaths = $_.Group |
                    ForEach-Object { $_.locations } |
                    ForEach-Object { $_.file.path }
                Measure-PairwiseDirectoryDistances -Paths $filePaths |
                    ForEach-Object {
                        [pscustomobject]@{
                            Kind = $kind
                            # Relate distances to maximum breadth
                            Scatter = $_ / $breadth
                        }
                    }
            }
    }
    # Group-Object -Property Kind |
    # ForEach-Object {
    #     $_.Group |
    #         Measure-Object -AllStats -Poperty Scatter |
    #         ForEach-Object {
    #             Add-Member -MemberType NoteProperty -Name Kind -Value $_.Name -InputObject $_
    #             $_
    #         }
    # }
