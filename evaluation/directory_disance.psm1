
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

Export-ModuleMember -Function Measure-DirectoryDistance, Measure-PairwiseDirectoryDistances
