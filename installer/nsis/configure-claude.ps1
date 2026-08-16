param(
    [Parameter(Mandatory = $false)]
    [string]$InstallDir,

    [Parameter(Mandatory = $false)]
    [switch]$Remove,

    # Fixture hook: production callers omit this and the normal Claude Desktop
    # locations are discovered. Tests use explicit paths and never touch a real
    # user configuration.
    [Parameter(Mandatory = $false)]
    [string[]]$ConfigPathOverride,

    [Parameter(Mandatory = $false)]
    [string[]]$ClaudeCodeConfigPathOverride,

    # Fixture-only concurrency hook. Production callers omit both values.
    [Parameter(Mandatory = $false)]
    [string]$BeforeWriteSignalPath,

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, 10000)]
    [int]$BeforeWriteDelayMilliseconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$OwnerId = "io.github.webmaster94.foundry-vtt-mcp"
$PrimaryEntryName = "foundry-mcp"
$KnownEntryNames = @("foundry-mcp", "foundry-vtt-mcp", "foundry-vtt-mcp-bridge")
$LogFile = Join-Path $env:TEMP "foundry-mcp-claude-config.log"

function Write-LogMessage {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Level] $Message"
    Write-Output $line
    Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Convert-ToFullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
}

function Test-PathEqual {
    param([string]$Left, [string]$Right)
    $fullLeft = Convert-ToFullPath $Left
    $fullRight = Convert-ToFullPath $Right
    if ($null -eq $fullLeft -or $null -eq $fullRight) {
        return $false
    }
    return [string]::Equals(
        $fullLeft.TrimEnd("\"),
        $fullRight.TrimEnd("\"),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-ObjectPropertyValue {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-ByteHash {
    param([byte[]]$Bytes)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace("-", "")
    }
    finally {
        $algorithm.Dispose()
    }
}

function Assert-RegularConfigurationFile {
    param([string]$ConfigPath)
    $item = Get-Item -LiteralPath $ConfigPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "JSON MCP client configuration is linked or not a regular file and was left unchanged: $ConfigPath"
    }
    return $item
}

function Invoke-BeforeWriteFixtureHook {
    if ([string]::IsNullOrWhiteSpace($BeforeWriteSignalPath)) {
        return
    }
    [System.IO.File]::WriteAllText(
        $BeforeWriteSignalPath,
        "ready",
        [System.Text.UTF8Encoding]::new($false)
    )
    if ($BeforeWriteDelayMilliseconds -gt 0) {
        Start-Sleep -Milliseconds $BeforeWriteDelayMilliseconds
    }
}

function Get-OnlyArgument {
    param([object]$Entry)
    $arguments = Get-ObjectPropertyValue $Entry "args"
    if ($null -eq $arguments -or @($arguments).Count -ne 1) {
        return $null
    }
    return [string]@($arguments)[0]
}

function Test-EntryOwnedByBridge {
    param([object]$Entry, [string]$ExpectedInstallDir)
    if ($null -eq $Entry -or -not ($Entry -is [PSCustomObject])) {
        return $false
    }

    $environment = Get-ObjectPropertyValue $Entry "env"
    if ($environment -is [PSCustomObject] -and
        [string](Get-ObjectPropertyValue $environment "FOUNDRY_MCP_MANAGED_BY") -eq $OwnerId) {
        return $true
    }

    $command = [string](Get-ObjectPropertyValue $Entry "command")
    $argument = Get-OnlyArgument $Entry
    if ([string]::IsNullOrWhiteSpace($command) -or [string]::IsNullOrWhiteSpace($argument)) {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedInstallDir)) {
        $desktopCommand = Join-Path $ExpectedInstallDir "FoundryVTT MCP Bridge.exe"
        $previousCommand = Join-Path $ExpectedInstallDir "runtime\node.exe"
        $currentArgument = Join-Path $ExpectedInstallDir "resources\server\index.bundle.cjs"
        $legacyCommand = Join-Path $ExpectedInstallDir "node.exe"
        $legacyArgument = Join-Path $ExpectedInstallDir "foundry-mcp-server\packages\mcp-server\dist\index.cjs"
        if (((Test-PathEqual $command $desktopCommand) -and (Test-PathEqual $argument $currentArgument)) -or
            ((Test-PathEqual $command $previousCommand) -and (Test-PathEqual $argument $currentArgument)) -or
            ((Test-PathEqual $command $legacyCommand) -and (Test-PathEqual $argument $legacyArgument))) {
            return $true
        }
    }

    # Recognize an entry made by a previous release even after the application
    # has moved. Both paths must form one exact, product-specific layout.
    $commandPath = Convert-ToFullPath $command
    $argumentPath = Convert-ToFullPath $argument
    if ($null -eq $commandPath -or $null -eq $argumentPath) {
        return $false
    }
    $legacyRoot = Split-Path -Parent $commandPath
    if ((Split-Path -Leaf $commandPath) -ieq "node.exe" -and
        (Test-PathEqual $argumentPath (Join-Path $legacyRoot "foundry-mcp-server\packages\mcp-server\dist\index.cjs"))) {
        return $true
    }
    if ((Split-Path -Leaf $commandPath) -ieq "node.exe" -and
        (Split-Path -Leaf $legacyRoot) -ieq "runtime") {
        $currentRoot = Split-Path -Parent $legacyRoot
        return (Test-PathEqual $argumentPath (Join-Path $currentRoot "resources\server\index.bundle.cjs"))
    }
    if ((Split-Path -Leaf $commandPath) -ieq "FoundryVTT MCP Bridge.exe") {
        return (Test-PathEqual $argumentPath (Join-Path $legacyRoot "resources\server\index.bundle.cjs"))
    }
    return $false
}

function Get-ClaudeConfigTargets {
    $hasClaudeOverride = $null -ne $ConfigPathOverride -and @($ConfigPathOverride).Count -gt 0
    $hasClaudeCodeOverride = (
        $null -ne $ClaudeCodeConfigPathOverride -and
        @($ClaudeCodeConfigPathOverride).Count -gt 0
    )
    if ($hasClaudeOverride -or $hasClaudeCodeOverride) {
        $fixtureTargets = [System.Collections.Generic.List[object]]::new()
        if ($hasClaudeOverride) {
            foreach ($path in @($ConfigPathOverride)) {
                $fixtureTargets.Add([PSCustomObject]@{
                    Kind = "Claude Desktop fixture"
                    Path = Convert-ToFullPath $path
                    Create = $true
                })
            }
        }
        if ($hasClaudeCodeOverride) {
            foreach ($path in @($ClaudeCodeConfigPathOverride)) {
                $fixtureTargets.Add([PSCustomObject]@{
                    Kind = "Claude Code fixture"
                    Path = Convert-ToFullPath $path
                    Create = $true
                })
            }
        }
        return @($fixtureTargets)
    }

    $targets = [System.Collections.Generic.List[object]]::new()
    $targets.Add([PSCustomObject]@{
        Kind = "Standalone"
        Path = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
        Create = $true
    })

    $packagesRoot = Join-Path $env:LOCALAPPDATA "Packages"
    if (Test-Path -LiteralPath $packagesRoot -PathType Container) {
        foreach ($package in Get-ChildItem -LiteralPath $packagesRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*Claude*" }) {
            $roaming = Join-Path $package.FullName "LocalCache\Roaming"
            if (Test-Path -LiteralPath $roaming -PathType Container) {
                $targets.Add([PSCustomObject]@{
                    Kind = "MSIX ($($package.Name))"
                    Path = Join-Path $roaming "Claude\claude_desktop_config.json"
                    Create = $true
                })
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $claudeCodeConfig = Join-Path $env:USERPROFILE ".claude.json"
        if (Test-Path -LiteralPath $claudeCodeConfig -PathType Leaf) {
            $targets.Add([PSCustomObject]@{
                Kind = "Claude Code (user scope)"
                Path = $claudeCodeConfig
                Create = $false
            })
        }
    }
    return @($targets)
}

function Read-ClaudeConfiguration {
    param([string]$ConfigPath, [switch]$AllowMissing)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        if ($AllowMissing) {
            return [PSCustomObject]@{
                Configuration = [PSCustomObject]@{}
                Existed = $false
                OriginalBytes = [byte[]]@()
                OriginalHash = $null
            }
        }
        return $null
    }
    $null = Assert-RegularConfigurationFile $ConfigPath
    $originalBytes = [System.IO.File]::ReadAllBytes($ConfigPath)
    $memory = [System.IO.MemoryStream]::new($originalBytes, $false)
    $reader = [System.IO.StreamReader]::new(
        $memory,
        [System.Text.UTF8Encoding]::new($false),
        $true
    )
    try {
        $contents = $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
        $memory.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($contents)) {
        throw "JSON MCP client configuration is empty and was left unchanged: $ConfigPath"
    }
    try {
        $config = $contents | ConvertFrom-Json
    }
    catch {
        throw "JSON MCP client configuration is invalid and was left unchanged: $ConfigPath"
    }
    if (-not ($config -is [PSCustomObject])) {
        throw "JSON MCP client configuration root is not an object and was left unchanged: $ConfigPath"
    }
    return [PSCustomObject]@{
        Configuration = $config
        Existed = $true
        OriginalBytes = $originalBytes
        OriginalHash = Get-ByteHash $originalBytes
    }
}

function Write-ClaudeConfiguration {
    param(
        [string]$ConfigPath,
        [object]$Configuration,
        [object]$OriginalDocument
    )
    $parent = Split-Path -Parent $ConfigPath
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    $json = $Configuration | ConvertTo-Json -Depth 100
    $null = $json | ConvertFrom-Json
    $temporaryPath = "$ConfigPath.tmp-$PID"
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
        $null = Get-Content -LiteralPath $temporaryPath -Raw | ConvertFrom-Json
        Invoke-BeforeWriteFixtureHook
        if ($OriginalDocument.Existed) {
            $null = Assert-RegularConfigurationFile $ConfigPath
            $currentBytes = [System.IO.File]::ReadAllBytes($ConfigPath)
            if ((Get-ByteHash $currentBytes) -ne [string]$OriginalDocument.OriginalHash) {
                throw "JSON MCP client configuration changed during migration and was left unchanged: $ConfigPath"
            }
            $backupPath = "$ConfigPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')-$([Guid]::NewGuid().ToString('N'))"
            if (Test-Path -LiteralPath $backupPath) {
                throw "Refusing to overwrite an existing JSON MCP client backup: $backupPath"
            }
            [System.IO.File]::Replace($temporaryPath, $ConfigPath, $backupPath, $true)
            Write-LogMessage "Backed up existing configuration to $backupPath"
        }
        else {
            if (Test-Path -LiteralPath $ConfigPath) {
                throw "JSON MCP client configuration was created concurrently and was left unchanged: $ConfigPath"
            }
            [System.IO.File]::Move($temporaryPath, $ConfigPath)
        }
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-McpServersObject {
    param([object]$Configuration)
    $mcpServers = Get-ObjectPropertyValue $Configuration "mcpServers"
    if ($null -eq $mcpServers) {
        $mcpServers = [PSCustomObject]@{}
        $Configuration | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value $mcpServers
    }
    elseif (-not ($mcpServers -is [PSCustomObject])) {
        throw "JSON MCP client mcpServers value is not an object and was left unchanged"
    }
    return $mcpServers
}

function Set-OwnedEntry {
    param([string]$ConfigPath, [string]$ResolvedInstallDir)
    $document = Read-ClaudeConfiguration -ConfigPath $ConfigPath -AllowMissing
    $configuration = $document.Configuration
    $mcpServers = Ensure-McpServersObject $configuration
    $existingProperty = $mcpServers.PSObject.Properties[$PrimaryEntryName]
    if ($null -ne $existingProperty -and
        -not (Test-EntryOwnedByBridge -Entry $existingProperty.Value -ExpectedInstallDir $ResolvedInstallDir)) {
        throw "The '$PrimaryEntryName' entry is not owned by this bridge and was left unchanged: $ConfigPath"
    }

    foreach ($legacyName in @("foundry-vtt-mcp", "foundry-vtt-mcp-bridge")) {
        $legacyProperty = $mcpServers.PSObject.Properties[$legacyName]
        if ($null -ne $legacyProperty -and
            (Test-EntryOwnedByBridge -Entry $legacyProperty.Value -ExpectedInstallDir $ResolvedInstallDir)) {
            $mcpServers.PSObject.Properties.Remove($legacyName)
            Write-LogMessage "Removed superseded installer-owned '$legacyName' entry from $ConfigPath"
        }
    }

    $canonicalConfig = Join-Path $env:APPDATA "FoundryVTT MCP Bridge\foundry-servers.json"
    $entry = [PSCustomObject]@{
        command = Join-Path $ResolvedInstallDir "FoundryVTT MCP Bridge.exe"
        args = @((Join-Path $ResolvedInstallDir "resources\server\index.bundle.cjs"))
        env = [PSCustomObject]@{
            ELECTRON_RUN_AS_NODE = "1"
            FOUNDRY_SERVERS_CONFIG = $canonicalConfig
            FOUNDRY_MCP_MANAGED_BY = $OwnerId
        }
    }
    if ($null -eq $existingProperty) {
        $mcpServers | Add-Member -MemberType NoteProperty -Name $PrimaryEntryName -Value $entry
    }
    else {
        $existingProperty.Value = $entry
    }
    Write-ClaudeConfiguration `
        -ConfigPath $ConfigPath `
        -Configuration $configuration `
        -OriginalDocument $document
    Write-LogMessage "Configured owned '$PrimaryEntryName' entry in $ConfigPath"
}

function Remove-OwnedEntries {
    param([string]$ConfigPath, [string]$ResolvedInstallDir)
    $document = Read-ClaudeConfiguration -ConfigPath $ConfigPath
    if ($null -eq $document) {
        return $false
    }
    $configuration = $document.Configuration
    $mcpServers = Get-ObjectPropertyValue $configuration "mcpServers"
    if (-not ($mcpServers -is [PSCustomObject])) {
        return $false
    }

    $removed = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $KnownEntryNames) {
        $property = $mcpServers.PSObject.Properties[$name]
        if ($null -ne $property -and
            (Test-EntryOwnedByBridge -Entry $property.Value -ExpectedInstallDir $ResolvedInstallDir)) {
            $mcpServers.PSObject.Properties.Remove($name)
            $removed.Add($name)
        }
    }
    if ($removed.Count -eq 0) {
        Write-LogMessage "No installer-owned MCP entry found in $ConfigPath"
        return $false
    }
    Write-ClaudeConfiguration `
        -ConfigPath $ConfigPath `
        -Configuration $configuration `
        -OriginalDocument $document
    Write-LogMessage "Removed only installer-owned entries ($($removed -join ', ')) from $ConfigPath"
    return $true
}

try {
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        throw "InstallDir is required"
    }
    $resolvedInstallDir = Convert-ToFullPath $InstallDir
    if ($null -eq $resolvedInstallDir) {
        throw "InstallDir must be an absolute path"
    }
    if (-not [string]::IsNullOrWhiteSpace($BeforeWriteSignalPath) -and
        ($null -eq $ConfigPathOverride -or @($ConfigPathOverride).Count -eq 0) -and
        ($null -eq $ClaudeCodeConfigPathOverride -or @($ClaudeCodeConfigPathOverride).Count -eq 0)) {
        throw "BeforeWriteSignalPath is available only with an explicit fixture configuration path"
    }

    $targets = Get-ClaudeConfigTargets
    $successCount = 0
    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($target in $targets) {
        if ([string]::IsNullOrWhiteSpace([string]$target.Path)) {
            $failures.Add("$($target.Kind): invalid configuration path")
            continue
        }
        try {
            if ($Remove) {
                if (Remove-OwnedEntries -ConfigPath $target.Path -ResolvedInstallDir $resolvedInstallDir) {
                    $successCount++
                }
            }
            else {
                $desktopExe = Join-Path $resolvedInstallDir "FoundryVTT MCP Bridge.exe"
                $serverBundle = Join-Path $resolvedInstallDir "resources\server\index.bundle.cjs"
                if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
                    throw "Desktop executable not found: $desktopExe"
                }
                if (-not (Test-Path -LiteralPath $serverBundle -PathType Leaf)) {
                    throw "MCP server bundle not found: $serverBundle"
                }
                Set-OwnedEntry -ConfigPath $target.Path -ResolvedInstallDir $resolvedInstallDir
                $successCount++
            }
        }
        catch {
            $failures.Add("$($target.Kind): $($_.Exception.Message)")
            Write-LogMessage $failures[$failures.Count - 1] "ERROR"
        }
    }

    if (-not $Remove -and $successCount -eq 0) {
        throw "No Claude Desktop or Claude Code configuration could be updated"
    }
    if ($failures.Count -gt 0) {
        throw "One or more Claude Desktop or Claude Code configurations were left unchanged: $($failures -join '; ')"
    }
    exit 0
}
catch {
    Write-LogMessage $_.Exception.Message "ERROR"
    Write-Error "$($_.Exception.Message). Details: $LogFile"
    exit 1
}
