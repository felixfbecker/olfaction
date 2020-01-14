# 2. How scattered are code smells in each commit over time?

[cmdletbinding()]
param(
    [Uri] $ServerUrl = [Uri]::new("http://localhost:4040"),
    $Result
)

function Measure-PairwiseDirectoryDistances {
    [CmdletBinding()]
    [outputtype([int])]
    param([string[]]$Paths)

    Write-Verbose "Measuring distances of $($Paths.Count) paths pairwise"
    $stack = [System.Collections.Generic.Stack[string]]::new($Paths)
    while ($stack.Count -gt 0) {
        $a = $stack.Pop()
        foreach ($b in $stack) {
            Measure-DirectoryDistance $a $b
        }
    }
}

function Measure-DirectoryDistance {
    [cmdletbinding()]
    [outputtype([int])]
    param([string]$a, [string]$b)

    $distance = 0
    # Walk up to common ancestor
    while (-not $b.StartsWith($a)) {
        $idx = $a.LastIndexOf('/')
        if ($idx -eq -1) {
            $idx = 0
        }
        $a = $a.Substring(0, $idx)
        $distance++
    }
    # Walk down to B and count directory separators
    for ($i = $a.Length; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq '/') {
            $distance++
        }
    }
    return $distance
}

$body = (@{
    query = '
        {
            repositories {
                edges {
                    node {
                        commits {
                            edges {
                                node {
                                    sha
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
                                                lifeSpan {
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
    '
    variables = @{ }
} | ConvertTo-Json)

if (-not $result) {
    $result = Invoke-RestMethod -Method POST -Uri ([Uri]::new($ServerUrl, "/graphql")) -Body $body -ContentType 'application/json'
}
$global:result = $result
if ($result.PSObject.Properties['errors'] -and $result.errors) {
    throw ($result.errors | ConvertTo-Json -Depth 100)
}
Write-Verbose "Got result"
$result.data.repositories.edges.node.commits.edges.node |
    ForEach-Object {
        $commit = $_
        Write-Verbose "Commit $($commit.sha)"
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
    } |
    Group-Object -Property Kind |
    ForEach-Object {
        $_.Group |
            Measure-Object -AllStats -Poperty Scatter |
            ForEach-Object {
                Add-Member -MemberType NoteProperty -Name Kind -Value $_.Name -InputObject $_
                $_
            }
    }
