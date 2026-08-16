param(
    [Parameter(Mandatory = $true)]
    [string]$ModuleRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet("Replace", "Uninstall")]
    [string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$OwnedDirectories = @("dist", "lang", "scripts", "styles", "templates")
$OwnedFile = "module.json"

function Get-ExistingItemNoFollow {
    param([string]$Path)
    try {
        return Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    }
}

function Convert-ToFullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
}

function Test-IsReparsePoint {
    param([string]$Path)
    $item = Get-ExistingItemNoFollow $Path
    if ($null -eq $item) {
        return $false
    }
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-NoReparseAncestors {
    param([string]$Path)
    $current = $Path
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if ((Test-Path -LiteralPath $current) -and (Test-IsReparsePoint $current)) {
            throw "Module cleanup path resolves through a reparse point: $current"
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $current = $parent
    }
}

function Assert-TreeHasNoReparsePoints {
    param([string]$Path)
    $item = Get-ExistingItemNoFollow $Path
    if ($null -eq $item) {
        return
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing module cleanup because an owned path is a reparse point: $Path"
    }
    if (-not $item.PSIsContainer) {
        return
    }
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop) {
        Assert-TreeHasNoReparsePoints $child.FullName
    }
}

function Remove-TreeNoFollow {
    param([string]$Path)
    $item = Get-ExistingItemNoFollow $Path
    if ($null -eq $item) {
        return
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not $item.PSIsContainer) {
        throw "Owned module directory changed type during cleanup: $Path"
    }
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop) {
        if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Owned module path became a reparse point during cleanup: $($child.FullName)"
        }
        if ($child.PSIsContainer) {
            Remove-TreeNoFollow $child.FullName
        }
        else {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
                $child.IsReadOnly = $false
            }
            [System.IO.File]::Delete($child.FullName)
        }
    }
    [System.IO.Directory]::Delete($Path, $false)
}

try {
    $resolvedRoot = Convert-ToFullPath $ModuleRoot
    if ($null -eq $resolvedRoot -or
        (Split-Path -Leaf $resolvedRoot) -ine "foundry-mcp-bridge" -or
        (Split-Path -Leaf (Split-Path -Parent $resolvedRoot)) -ine "modules") {
        throw "ModuleRoot must be an absolute foundry-mcp-bridge directory below modules"
    }
    Assert-NoReparseAncestors $resolvedRoot
    $rootItem = Get-ExistingItemNoFollow $resolvedRoot
    if ($null -eq $rootItem) {
        Write-Output "[module-cleanup] No previous module payload exists"
        exit 0
    }
    if (-not $rootItem.PSIsContainer -or
        (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Module root is linked or is not a directory: $resolvedRoot"
    }

    # Preflight every allowlisted target before the first mutation. A nested
    # junction in any tree prevents cleanup of all trees.
    foreach ($directory in $OwnedDirectories) {
        Assert-TreeHasNoReparsePoints (Join-Path $resolvedRoot $directory)
    }
    $ownedFilePath = Join-Path $resolvedRoot $OwnedFile
    $ownedFileItem = Get-ExistingItemNoFollow $ownedFilePath
    if ($null -ne $ownedFileItem) {
        if ($ownedFileItem.PSIsContainer -or
            (($ownedFileItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Owned module metadata path is linked or is not a regular file: $ownedFilePath"
        }
    }

    foreach ($directory in $OwnedDirectories) {
        Remove-TreeNoFollow (Join-Path $resolvedRoot $directory)
    }
    $ownedFileItem = Get-ExistingItemNoFollow $ownedFilePath
    if ($null -ne $ownedFileItem) {
        if (($ownedFileItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $ownedFileItem.PSIsContainer) {
            throw "Owned module metadata changed type during cleanup: $ownedFilePath"
        }
        if (($ownedFileItem.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
            $ownedFileItem.IsReadOnly = $false
        }
        [System.IO.File]::Delete($ownedFilePath)
    }
    if ($Mode -eq "Uninstall") {
        try {
            [System.IO.Directory]::Delete($resolvedRoot, $false)
        }
        catch [System.IO.IOException] {
            # Unknown/user-created content intentionally keeps the root present.
        }
    }
    Write-Output "[module-cleanup] Removed only allowlisted module payload for $Mode"
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
