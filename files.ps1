$rootPath = Get-Location
$outputFile = "tree_structure.txt"

function Get-TreeStructure {
    param(
        [string]$path,
        [int]$depth = 0
    )
    
    $indent = "  " * $depth
    
    try {
        $items = Get-ChildItem -Path $path -ErrorAction SilentlyContinue | Sort-Object -Property Name
        
        foreach ($item in $items) {
            if ($item.PSIsContainer) {
                "$indent|- $($item.Name)/"
                Get-TreeStructure -path $item.FullName -depth ($depth + 1)
            } else {
                "$indent|- $($item.Name)"
            }
        }
    } catch {
        Write-Verbose "Error accessing $path : $_"
    }
}

# Generate tree structure
$treeOutput = @()
$treeOutput += "$rootPath"
$treeOutput += Get-TreeStructure -path $rootPath

# Write to file
$treeOutput | Out-File -FilePath $outputFile -Encoding UTF8

Write-Host "Tree structure saved to $outputFile"
