param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Prepare", "Finalize", "Uninstall")]
    [string]$Phase,

    [Parameter(Mandatory = $true)]
    [string]$NewInstallDir,

    [Parameter(Mandatory = $false)]
    [string]$CanonicalConfigPath,

    [Parameter(Mandatory = $false)]
    [string]$PreviousInstallDir,

    [Parameter(Mandatory = $false)]
    [string]$StateFile,

    [Parameter(Mandatory = $false)]
    [switch]$DisableRegistryDiscovery
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProductId = "io.github.webmaster94.foundry-vtt-mcp"
$InstallMarkerName = "foundry-vtt-mcp-bridge.install-id"
$OwnedManifestName = "installer-owned-files.json"
$UninstallRegistryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer"
$LegacyDefaultInstallDir = Join-Path $env:LOCALAPPDATA "FoundryMCPServer"

function Write-MigrationLog {
    param([string]$Message)
    Write-Output "[installer-migration] $Message"
}

function Get-ObjectPropertyValue {
    param(
        [object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Convert-ToFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "A required path was empty"
    }
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
}

function Test-PathEqual {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    return [string]::Equals(
        (Convert-ToFullPath $Left).TrimEnd("\"),
        (Convert-ToFullPath $Right).TrimEnd("\"),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-IsWithinRoot {
    param([string]$Candidate, [string]$Root)
    $fullCandidate = Convert-ToFullPath $Candidate
    $fullRoot = (Convert-ToFullPath $Root).TrimEnd("\")
    if (Test-PathEqual $fullCandidate $fullRoot) {
        return $true
    }
    return $fullCandidate.StartsWith(
        "$fullRoot\",
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-IsReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-RootIsSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowMissing
    )

    $fullPath = Convert-ToFullPath $Path
    $trimmed = $fullPath.TrimEnd("\")
    $root = ([System.IO.Path]::GetPathRoot($fullPath)).TrimEnd("\")
    if ([string]::IsNullOrWhiteSpace($root) -or
        [string]::Equals($trimmed, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use a drive root as an installation directory: $fullPath"
    }

    $protectedRoots = @(
        $env:SystemRoot,
        $env:WINDIR,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:USERPROFILE,
        $env:LOCALAPPDATA,
        $env:APPDATA
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($protectedRoot in $protectedRoots) {
        if (Test-PathEqual $fullPath $protectedRoot) {
            throw "Refusing to use protected directory as installation root: $fullPath"
        }
    }

    if (-not (Test-Path -LiteralPath $fullPath)) {
        if ($AllowMissing) {
            return $fullPath
        }
        throw "Installation directory does not exist: $fullPath"
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Installation root is not a directory: $fullPath"
    }
    if (Test-IsReparsePoint $fullPath) {
        throw "Refusing reparse-point installation root: $fullPath"
    }
    return $fullPath
}

function Assert-NoReparseAncestors {
    param([string]$Candidate, [string]$Root)
    $fullRoot = Convert-ToFullPath $Root
    $current = Convert-ToFullPath $Candidate
    if (-not (Test-IsWithinRoot $current $fullRoot)) {
        throw "Path escapes installation root: $current"
    }

    while (Test-IsWithinRoot $current $fullRoot) {
        if ((Test-Path -LiteralPath $current) -and (Test-IsReparsePoint $current)) {
            throw "Refusing path containing a reparse point: $current"
        }
        if (Test-PathEqual $current $fullRoot) {
            break
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or (Test-PathEqual $parent $current)) {
            throw "Could not validate parent path for $current"
        }
        $current = $parent
    }
}

function Assert-TreeHasNoReparsePoints {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (Test-IsReparsePoint $Path) {
        throw "Refusing to traverse reparse point: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
        return
    }
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
        if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing payload tree containing reparse point: $($child.FullName)"
        }
        if ($child.PSIsContainer) {
            Assert-TreeHasNoReparsePoints $child.FullName
        }
    }
}

function Remove-TreeWithoutFollowingLinks {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-TreeHasNoReparsePoints $Path
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
        if ($child.PSIsContainer) {
            Remove-TreeWithoutFollowingLinks $child.FullName
        }
        else {
            [System.IO.File]::Delete($child.FullName)
        }
    }
    [System.IO.Directory]::Delete($Path, $false)
}

function Test-IsNewOwnedInstall {
    param([string]$InstallDir)
    $marker = Join-Path $InstallDir $InstallMarkerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        return $false
    }
    return ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $ProductId)
}

function Test-IsLegacyOwnedInstall {
    param([string]$InstallDir)
    return (
        (Test-Path -LiteralPath (Join-Path $InstallDir "node.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $InstallDir "Uninstall.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (
            Join-Path $InstallDir "foundry-mcp-server\packages\mcp-server\dist\index.cjs"
        ) -PathType Leaf)
    )
}

function Test-IsOwnedInstall {
    param([string]$InstallDir)
    if ([string]::IsNullOrWhiteSpace($InstallDir) -or
        -not (Test-Path -LiteralPath $InstallDir -PathType Container) -or
        (Test-IsReparsePoint $InstallDir)) {
        return $false
    }
    return ((Test-IsNewOwnedInstall $InstallDir) -or (Test-IsLegacyOwnedInstall $InstallDir))
}

function Get-PreviousOwnedInstallDir {
    if (-not [string]::IsNullOrWhiteSpace($PreviousInstallDir)) {
        $override = Convert-ToFullPath $PreviousInstallDir
        if (Test-IsOwnedInstall $override) {
            return $override
        }
        Write-MigrationLog "Ignoring unrecognized previous-install override: $override"
        return $null
    }

    if (-not $DisableRegistryDiscovery -and (Test-Path -LiteralPath $UninstallRegistryPath)) {
        $registration = Get-ItemProperty -LiteralPath $UninstallRegistryPath
        $registeredName = [string](Get-ObjectPropertyValue $registration "DisplayName")
        if ($registeredName -in @("Foundry MCP Server", "Foundry VTT MCP Bridge")) {
            $candidates = [System.Collections.Generic.List[string]]::new()
            $registeredLocation = [string](Get-ObjectPropertyValue $registration "InstallLocation")
            if (-not [string]::IsNullOrWhiteSpace($registeredLocation)) {
                $candidates.Add($registeredLocation)
            }
            $uninstallCommand = [string](Get-ObjectPropertyValue $registration "UninstallString")
            if ($uninstallCommand -match '^\s*"(?<exe>[^"]+\\Uninstall\.exe)"') {
                $candidates.Add((Split-Path -Parent $Matches.exe))
            }
            elseif ($uninstallCommand -match '^\s*(?<exe>.+?\\Uninstall\.exe)(?:\s|$)') {
                $candidates.Add((Split-Path -Parent $Matches.exe.Trim()))
            }
            foreach ($candidate in $candidates) {
                $fullCandidate = Convert-ToFullPath $candidate
                if (Test-IsOwnedInstall $fullCandidate) {
                    return $fullCandidate
                }
                Write-MigrationLog "Registry candidate is not an owned installation; leaving it untouched: $fullCandidate"
            }
        }
    }

    if (Test-IsOwnedInstall $LegacyDefaultInstallDir) {
        return (Convert-ToFullPath $LegacyDefaultInstallDir)
    }
    return $null
}

function Write-MigrationState {
    param([string]$Path, [string]$PreviousRoot)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    $fullPath = Convert-ToFullPath $Path
    $parent = Split-Path -Parent $fullPath
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Migration state parent does not exist: $parent"
    }
    if (Test-IsReparsePoint $parent) {
        throw "Refusing reparse-point migration state parent: $parent"
    }
    $state = [ordered]@{
        schemaVersion = 1
        productId = $ProductId
        previousInstallDir = $PreviousRoot
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($fullPath, $state, [System.Text.UTF8Encoding]::new($false))
}

function Read-MigrationStatePreviousRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    $fullPath = Convert-ToFullPath $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        return $null
    }
    $state = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json
    if ((Get-ObjectPropertyValue $state "schemaVersion") -ne 1 -or
        (Get-ObjectPropertyValue $state "productId") -ne $ProductId) {
        throw "Migration state identity is invalid: $fullPath"
    }
    $candidate = [string](Get-ObjectPropertyValue $state "previousInstallDir")
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $null
    }
    $fullCandidate = Convert-ToFullPath $candidate
    if (-not (Test-IsOwnedInstall $fullCandidate)) {
        Write-MigrationLog "State file no longer points to an owned installation; leaving it untouched: $fullCandidate"
        return $null
    }
    return $fullCandidate
}

function Get-OwnedManifestFiles {
    param([string]$InstallDir)
    $manifestPath = Join-Path $InstallDir $OwnedManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Owned-file manifest is missing: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ((Get-ObjectPropertyValue $manifest "schemaVersion") -ne 1 -or
        (Get-ObjectPropertyValue $manifest "productId") -ne $ProductId) {
        throw "Owned-file manifest identity is invalid: $manifestPath"
    }
    $manifestFiles = Get-ObjectPropertyValue $manifest "files"
    if ($null -eq $manifestFiles -or @($manifestFiles).Count -eq 0) {
        throw "Owned-file manifest contains no files: $manifestPath"
    }

    $resolved = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($relativePathValue in @($manifestFiles)) {
        $relativePath = [string]$relativePathValue
        if ([string]::IsNullOrWhiteSpace($relativePath) -or
            [System.IO.Path]::IsPathRooted($relativePath)) {
            throw "Owned-file manifest contains an invalid path: $relativePath"
        }
        $candidate = Convert-ToFullPath (Join-Path $InstallDir $relativePath)
        if (-not (Test-IsWithinRoot $candidate $InstallDir) -or (Test-PathEqual $candidate $InstallDir)) {
            throw "Owned-file manifest path escapes installation root: $relativePath"
        }
        Assert-NoReparseAncestors -Candidate $candidate -Root $InstallDir
        if ((Test-Path -LiteralPath $candidate) -and
            (Test-Path -LiteralPath $candidate -PathType Container)) {
            throw "Owned-file manifest listed a directory instead of a file: $relativePath"
        }
        if ($seen.Add($candidate)) {
            $resolved.Add($candidate)
        }
    }
    return $resolved
}

function Remove-ManifestOwnedPayload {
    param([string]$InstallDir)
    $fullInstallDir = Assert-RootIsSafe -Path $InstallDir
    $files = Get-OwnedManifestFiles $fullInstallDir
    $directories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    foreach ($file in $files) {
        $parent = Split-Path -Parent $file
        while ((Test-IsWithinRoot $parent $fullInstallDir) -and
            -not (Test-PathEqual $parent $fullInstallDir)) {
            [void]$directories.Add($parent)
            $parent = Split-Path -Parent $parent
        }
    }

    foreach ($file in ($files | Sort-Object { $_.Length } -Descending)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            [System.IO.File]::Delete($file)
        }
    }

    foreach ($directory in ($directories | Sort-Object { $_.Length } -Descending)) {
        if ((Test-Path -LiteralPath $directory -PathType Container) -and
            -not (Test-IsReparsePoint $directory)) {
            try {
                [System.IO.Directory]::Delete($directory, $false)
            }
            catch [System.IO.IOException] {
                # Unknown/user files intentionally keep their parent directory.
            }
        }
    }
    Write-MigrationLog "Removed only manifest-owned payload from $fullInstallDir"
}

function Remove-LegacyOwnedPayload {
    param([string]$InstallDir)
    $fullInstallDir = Assert-RootIsSafe -Path $InstallDir
    if (-not (Test-IsLegacyOwnedInstall $fullInstallDir)) {
        throw "Refusing legacy cleanup without the full legacy ownership fingerprint: $fullInstallDir"
    }

    $legacyDirectories = @("node", "foundry-mcp-server")
    $legacyFiles = @(
        "node.exe",
        "README.txt",
        "LICENSE.txt",
        "icon.ico",
        "configure-claude.ps1",
        "configure-claude-wrapper.bat",
        "start-server.bat",
        "test-connection.bat",
        "start-comfyui.bat",
        "test-comfyui.bat",
        "THIRD_PARTY_NOTICES.txt",
        "Uninstall.exe"
    )

    # Preflight the complete allowlist before deleting anything.
    foreach ($relativePath in $legacyDirectories + $legacyFiles) {
        $candidate = Convert-ToFullPath (Join-Path $fullInstallDir $relativePath)
        if (-not (Test-IsWithinRoot $candidate $fullInstallDir)) {
            throw "Legacy allowlist path escaped installation root: $relativePath"
        }
        Assert-NoReparseAncestors -Candidate $candidate -Root $fullInstallDir
        if (Test-Path -LiteralPath $candidate) {
            Assert-TreeHasNoReparsePoints $candidate
        }
    }

    foreach ($relativePath in $legacyDirectories) {
        Remove-TreeWithoutFollowingLinks (Join-Path $fullInstallDir $relativePath)
    }
    foreach ($relativePath in $legacyFiles) {
        $candidate = Join-Path $fullInstallDir $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            [System.IO.File]::Delete($candidate)
        }
    }
    Write-MigrationLog "Removed only the fixed legacy payload allowlist from $fullInstallDir"
}

function Remove-OwnedPayload {
    param([string]$InstallDir)
    if (Test-IsNewOwnedInstall $InstallDir) {
        Remove-ManifestOwnedPayload $InstallDir
        return
    }
    if (Test-IsLegacyOwnedInstall $InstallDir) {
        Remove-LegacyOwnedPayload $InstallDir
        return
    }
    throw "Refusing to clean an unrecognized installation root: $InstallDir"
}

function Test-DirectoryEmpty {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $true
    }
    return ($null -eq (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1))
}

function Test-ServerConfigValid {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $servers = Get-ObjectPropertyValue $parsed "servers"
        return (
            ($parsed -is [PSCustomObject]) -and
            ($servers -is [PSCustomObject]) -and
            (@($servers.PSObject.Properties).Count -gt 0)
        )
    }
    catch {
        return $false
    }
}

function Add-AbsoluteConfigCandidate {
    param(
        [System.Collections.Generic.List[string]]$Candidates,
        [object]$Value
    )
    $candidate = [string]$Value
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and
        [System.IO.Path]::IsPathRooted($candidate)) {
        $Candidates.Add($candidate)
    }
}

function Add-ClaudeConfigCandidates {
    param([System.Collections.Generic.List[string]]$Candidates)
    $configPaths = [System.Collections.Generic.List[string]]::new()
    $configPaths.Add((Join-Path $env:APPDATA "Claude\claude_desktop_config.json"))

    $packagesRoot = Join-Path $env:LOCALAPPDATA "Packages"
    if ((Test-Path -LiteralPath $packagesRoot -PathType Container) -and
        -not (Test-IsReparsePoint $packagesRoot)) {
        foreach ($package in Get-ChildItem -LiteralPath $packagesRoot -Directory -ErrorAction SilentlyContinue) {
            if ($package.Name -notlike "*Claude*" -or
                (($package.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
                continue
            }
            $configPaths.Add((Join-Path $package.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json"))
        }
    }

    foreach ($configPath in $configPaths) {
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            continue
        }
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            $mcpServers = Get-ObjectPropertyValue $config "mcpServers"
            if (-not ($mcpServers -is [PSCustomObject])) {
                continue
            }
            foreach ($name in @("foundry-mcp", "foundry-vtt-mcp", "foundry-vtt-mcp-bridge")) {
                $entry = Get-ObjectPropertyValue $mcpServers $name
                $environment = Get-ObjectPropertyValue $entry "env"
                if ($environment -is [PSCustomObject]) {
                    Add-AbsoluteConfigCandidate $Candidates (
                        Get-ObjectPropertyValue $environment "FOUNDRY_SERVERS_CONFIG"
                    )
                }
            }
        }
        catch {
            Write-MigrationLog "Ignoring unreadable Claude configuration while discovering server profiles: $configPath"
        }
    }
}

function ConvertFrom-TomlQuotedString {
    param([string]$Value)
    $trimmed = $Value.Trim()
    if ($trimmed.Length -ge 2 -and $trimmed[0] -eq "'" -and $trimmed[$trimmed.Length - 1] -eq "'") {
        return $trimmed.Substring(1, $trimmed.Length - 2)
    }
    if ($trimmed.Length -ge 2 -and $trimmed[0] -eq '"' -and $trimmed[$trimmed.Length - 1] -eq '"') {
        try {
            return [string]($trimmed | ConvertFrom-Json)
        }
        catch {
            return $null
        }
    }
    return $null
}

function Add-CodexConfigCandidates {
    param([System.Collections.Generic.List[string]]$Candidates)
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return
    }
    $configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return
    }

    try {
        $knownNamePattern = "foundry-mcp|foundry-vtt-mcp|foundry-vtt-mcp-bridge"
        $knownEnvironmentHeader = (
            '^\s*\[\s*(?:"mcp_servers"|''mcp_servers''|mcp_servers)\s*\.\s*' +
            '(?:"(?:' + $knownNamePattern + ')"|''(?:' + $knownNamePattern + ')''|(?:' +
            $knownNamePattern + '))\s*\.\s*(?:"env"|''env''|env)\s*\]\s*(?:#.*)?$'
        )
        $insideKnownServer = $false
        $multilineDelimiter = $null
        foreach ($line in Get-Content -LiteralPath $configPath) {
            if ($null -ne $multilineDelimiter) {
                if ($line.Contains($multilineDelimiter)) {
                    $multilineDelimiter = $null
                }
                continue
            }
            if ($line.TrimStart().StartsWith("#")) {
                continue
            }
            if ($line.Contains('"""')) {
                $multilineDelimiter = '"""'
                continue
            }
            if ($line.Contains("'''")) {
                $multilineDelimiter = "'''"
                continue
            }
            if ($line -match '^\s*\[') {
                $insideKnownServer = $line -match $knownEnvironmentHeader
                continue
            }
            if (-not $insideKnownServer) {
                continue
            }
            if ($line -match '^\s*FOUNDRY_SERVERS_CONFIG\s*=\s*(?<value>"(?:\\.|[^"\\])*"|''[^'']*'')\s*(?:#.*)?$') {
                $value = ConvertFrom-TomlQuotedString $Matches.value
                if ($null -ne $value) {
                    Add-AbsoluteConfigCandidate $Candidates $value
                }
            }
        }
    }
    catch {
        Write-MigrationLog "Ignoring unreadable Codex configuration while discovering server profiles: $configPath"
    }
}

function Get-KnownClientConfigCandidates {
    $candidates = [System.Collections.Generic.List[string]]::new()
    Add-ClaudeConfigCandidates $candidates
    Add-CodexConfigCandidates $candidates
    return $candidates
}

function Assert-ConfigParentSafe {
    param([string]$ConfigPath)
    $parent = Split-Path -Parent (Convert-ToFullPath $ConfigPath)
    $current = $parent
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-Path -LiteralPath $current) {
            if (-not (Test-Path -LiteralPath $current -PathType Container) -or
                (Test-IsReparsePoint $current)) {
                throw "Configuration parent resolves through an unsafe path: $current"
            }
        }
        $next = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($next) -or (Test-PathEqual $next $current)) {
            break
        }
        $current = $next
    }
    return $parent
}

function Write-ConfigAtomically {
    param([string]$ConfigPath, [string]$Content)
    $fullPath = Convert-ToFullPath $ConfigPath
    $parent = Assert-ConfigParentSafe $fullPath
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    if (Test-IsReparsePoint $parent) {
        throw "Refusing reparse-point configuration directory: $parent"
    }
    $temporaryPath = "$fullPath.tmp-$PID"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $Content,
            [System.Text.UTF8Encoding]::new($false)
        )
        if (-not (Test-ServerConfigValid $temporaryPath)) {
            throw "Generated server configuration failed validation"
        }
        Move-Item -LiteralPath $temporaryPath -Destination $fullPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-CanonicalConfig {
    param([string]$ConfigPath, [string]$PreviousDir)
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        throw "CanonicalConfigPath is required during installation"
    }
    $fullConfigPath = Convert-ToFullPath $ConfigPath
    if (Test-Path -LiteralPath $fullConfigPath) {
        if (-not (Test-ServerConfigValid $fullConfigPath)) {
            throw "Existing canonical server configuration is invalid and was left unchanged: $fullConfigPath"
        }
        Write-MigrationLog "Preserving canonical server configuration: $fullConfigPath"
        return
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:FOUNDRY_SERVERS_CONFIG) -and
        [System.IO.Path]::IsPathRooted($env:FOUNDRY_SERVERS_CONFIG)) {
        $candidates.Add($env:FOUNDRY_SERVERS_CONFIG)
    }
    foreach ($clientCandidate in Get-KnownClientConfigCandidates) {
        $candidates.Add($clientCandidate)
    }
    if (-not [string]::IsNullOrWhiteSpace($PreviousDir)) {
        $candidates.Add((Join-Path $PreviousDir "foundry-servers.json"))
        $candidates.Add((Join-Path $PreviousDir "resources\server\foundry-servers.json"))
        $candidates.Add((Join-Path $PreviousDir "foundry-mcp-server\packages\mcp-server\dist\foundry-servers.json"))
    }
    $candidates.Add((Join-Path $LegacyDefaultInstallDir "foundry-servers.json"))

    $visited = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($candidate in $candidates) {
        $fullCandidate = Convert-ToFullPath $candidate
        if ($visited.Add($fullCandidate) -and (Test-ServerConfigValid $fullCandidate)) {
            $content = Get-Content -LiteralPath $fullCandidate -Raw
            Write-ConfigAtomically -ConfigPath $fullConfigPath -Content $content
            Write-MigrationLog "Copied server configuration to canonical path from $fullCandidate"
            return
        }
    }

    $defaultConfig = @'
{
  "defaultServer": "default",
  "servers": {
    "default": {
      "label": "Default Foundry world",
      "host": "localhost",
      "port": 31415,
      "connectionType": "auto",
      "remoteMode": false
    }
  }
}
'@
    Write-ConfigAtomically -ConfigPath $fullConfigPath -Content $defaultConfig
    Write-MigrationLog "Created initial canonical server configuration: $fullConfigPath"
}

$newRoot = Assert-RootIsSafe -Path $NewInstallDir -AllowMissing
$previousRoot = if ($Phase -eq "Finalize") {
    $stateRoot = Read-MigrationStatePreviousRoot $StateFile
    if ($null -ne $stateRoot) {
        $stateRoot
    }
    else {
        Get-PreviousOwnedInstallDir
    }
}
else {
    Get-PreviousOwnedInstallDir
}

switch ($Phase) {
    "Prepare" {
        Write-MigrationState -Path $StateFile -PreviousRoot $previousRoot
        Initialize-CanonicalConfig -ConfigPath $CanonicalConfigPath -PreviousDir $previousRoot

        if (Test-Path -LiteralPath $newRoot -PathType Container) {
            if (Test-IsOwnedInstall $newRoot) {
                Remove-OwnedPayload $newRoot
            }
            elseif (-not (Test-DirectoryEmpty $newRoot)) {
                throw "Selected installation directory is non-empty and is not an owned installation: $newRoot"
            }
        }
        Write-MigrationLog "Install destination is ready: $newRoot"
    }
    "Finalize" {
        if (-not [string]::IsNullOrWhiteSpace($previousRoot) -and
            -not (Test-PathEqual $previousRoot $newRoot) -and
            (Test-IsOwnedInstall $previousRoot)) {
            Remove-OwnedPayload $previousRoot
            $previousUninstaller = Join-Path $previousRoot "Uninstall.exe"
            Assert-NoReparseAncestors -Candidate $previousUninstaller -Root $previousRoot
            if (Test-Path -LiteralPath $previousUninstaller -PathType Leaf) {
                [System.IO.File]::Delete($previousUninstaller)
            }
            try {
                [System.IO.Directory]::Delete($previousRoot, $false)
            }
            catch [System.IO.IOException] {
                Write-MigrationLog "Legacy directory contains unknown/user files and was preserved: $previousRoot"
            }
        }
        Write-MigrationLog "Legacy migration finalized"
    }
    "Uninstall" {
        if (-not (Test-IsNewOwnedInstall $newRoot)) {
            throw "Refusing uninstall cleanup without the current product marker: $newRoot"
        }
        Remove-ManifestOwnedPayload $newRoot
        Write-MigrationLog "Application settings were preserved at $CanonicalConfigPath"
    }
}
