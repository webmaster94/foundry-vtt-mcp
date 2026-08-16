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

# Windows PowerShell 5.1's ConvertFrom-Json rejects valid objects containing
# an empty-string property name. Claude Code can legitimately create such
# properties in ~/.claude.json, so use the .NET Framework JSON parser and
# retain object maps as dictionaries instead.
Add-Type -AssemblyName System.Web.Extensions
$JsonSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$JsonSerializer.MaxJsonLength = [int]::MaxValue
$JsonSerializer.RecursionLimit = 200

function Write-LogMessage {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Level] $Message"
    Write-Output $line
    Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue
}

try {
    [System.IO.File]::WriteAllText($LogFile, "", [System.Text.UTF8Encoding]::new($false))
}
catch {
    # Logging must never make client configuration fail.
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
    if ($Object -is [System.Collections.IDictionary]) {
        $hasKey = if ($null -ne $Object.PSObject.Methods["ContainsKey"]) {
            $Object.ContainsKey($Name)
        }
        else {
            $Object.Contains($Name)
        }
        if ($hasKey) {
            return $Object[$Name]
        }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Test-IsObjectMap {
    param([object]$Object)
    return ($Object -is [System.Collections.IDictionary] -or $Object -is [PSCustomObject])
}

function Test-ObjectPropertyExists {
    param([object]$Object, [string]$Name)
    if ($Object -is [System.Collections.IDictionary]) {
        if ($null -ne $Object.PSObject.Methods["ContainsKey"]) {
            return $Object.ContainsKey($Name)
        }
        return $Object.Contains($Name)
    }
    return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}

function Set-ObjectPropertyValue {
    param([object]$Object, [string]$Name, [object]$Value)
    if ($Object -is [System.Collections.IDictionary]) {
        $Object[$Name] = $Value
        return
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
    else {
        $property.Value = $Value
    }
}

function Remove-ObjectProperty {
    param([object]$Object, [string]$Name)
    if ($Object -is [System.Collections.IDictionary]) {
        $Object.Remove($Name)
        return
    }
    $Object.PSObject.Properties.Remove($Name)
}

function ConvertFrom-CompatibleJson {
    param([string]$Json)
    return $JsonSerializer.DeserializeObject($Json)
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

function Test-IsVerifiedBridgeSourceEntry {
    param([string]$Command, [string]$Argument)
    $commandName = [System.IO.Path]::GetFileName($Command)
    if ($Command -notin @("node", "node.exe") -and $commandName -ine "node.exe") {
        return $false
    }

    $scriptPath = Convert-ToFullPath $Argument
    if ($null -eq $scriptPath -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return $false
    }
    if ([System.IO.Path]::GetFileName($scriptPath) -notin @("index.js", "index.cjs")) {
        return $false
    }

    $distRoot = Split-Path -Parent $scriptPath
    $serverRoot = Split-Path -Parent $distRoot
    $packagesRoot = Split-Path -Parent $serverRoot
    $repositoryRoot = Split-Path -Parent $packagesRoot
    if ((Split-Path -Leaf $distRoot) -ine "dist" -or
        (Split-Path -Leaf $serverRoot) -ine "mcp-server" -or
        (Split-Path -Leaf $packagesRoot) -ine "packages") {
        return $false
    }

    $rootPackagePath = Join-Path $repositoryRoot "package.json"
    $serverPackagePath = Join-Path $serverRoot "package.json"
    $moduleManifestPath = Join-Path $packagesRoot "foundry-module\module.json"
    foreach ($path in @($rootPackagePath, $serverPackagePath, $moduleManifestPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $false
        }
    }

    try {
        $rootPackage = ConvertFrom-CompatibleJson ([System.IO.File]::ReadAllText($rootPackagePath))
        $serverPackage = ConvertFrom-CompatibleJson ([System.IO.File]::ReadAllText($serverPackagePath))
        $moduleManifest = ConvertFrom-CompatibleJson ([System.IO.File]::ReadAllText($moduleManifestPath))
        $repository = Get-ObjectPropertyValue $rootPackage "repository"
        return (
            [string](Get-ObjectPropertyValue $rootPackage "name") -eq "foundry-mcp-integration" -and
            [string](Get-ObjectPropertyValue $repository "url") -eq "https://github.com/webmaster94/foundry-vtt-mcp.git" -and
            [string](Get-ObjectPropertyValue $serverPackage "name") -eq "@foundry-mcp/server" -and
            [string](Get-ObjectPropertyValue $moduleManifest "id") -eq "foundry-mcp-bridge"
        )
    }
    catch {
        return $false
    }
}

function Test-EntryOwnedByBridge {
    param([object]$Entry, [string]$ExpectedInstallDir, [switch]$AllowVerifiedSource)
    if (-not (Test-IsObjectMap $Entry)) {
        return $false
    }

    $environment = Get-ObjectPropertyValue $Entry "env"
    if ((Test-IsObjectMap $environment) -and
        [string](Get-ObjectPropertyValue $environment "FOUNDRY_MCP_MANAGED_BY") -eq $OwnerId) {
        return $true
    }

    $command = [string](Get-ObjectPropertyValue $Entry "command")
    $argument = Get-OnlyArgument $Entry
    if ([string]::IsNullOrWhiteSpace($command) -or [string]::IsNullOrWhiteSpace($argument)) {
        return $false
    }

    if ($AllowVerifiedSource -and (Test-IsVerifiedBridgeSourceEntry $command $argument)) {
        return $true
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
        $config = ConvertFrom-CompatibleJson $contents
    }
    catch {
        throw "JSON MCP client configuration is invalid and was left unchanged: $ConfigPath"
    }
    if (-not (Test-IsObjectMap $config)) {
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
    $null = ConvertFrom-CompatibleJson $json
    $temporaryPath = "$ConfigPath.tmp-$PID"
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
        $null = ConvertFrom-CompatibleJson (Get-Content -LiteralPath $temporaryPath -Raw)
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
        $mcpServers = [ordered]@{}
        Set-ObjectPropertyValue $Configuration "mcpServers" $mcpServers
    }
    elseif (-not (Test-IsObjectMap $mcpServers)) {
        throw "JSON MCP client mcpServers value is not an object and was left unchanged"
    }
    return $mcpServers
}

function Set-OwnedEntry {
    param([string]$ConfigPath, [string]$ResolvedInstallDir)
    $document = Read-ClaudeConfiguration -ConfigPath $ConfigPath -AllowMissing
    $configuration = $document.Configuration
    $mcpServers = Ensure-McpServersObject $configuration
    $hasExistingEntry = Test-ObjectPropertyExists $mcpServers $PrimaryEntryName
    $existingEntry = Get-ObjectPropertyValue $mcpServers $PrimaryEntryName
    if ($hasExistingEntry -and
        -not (Test-EntryOwnedByBridge -Entry $existingEntry -ExpectedInstallDir $ResolvedInstallDir -AllowVerifiedSource)) {
        throw "The '$PrimaryEntryName' entry is not owned by this bridge and was left unchanged: $ConfigPath"
    }

    foreach ($legacyName in @("foundry-vtt-mcp", "foundry-vtt-mcp-bridge")) {
        $legacyEntry = Get-ObjectPropertyValue $mcpServers $legacyName
        if ((Test-ObjectPropertyExists $mcpServers $legacyName) -and
            (Test-EntryOwnedByBridge -Entry $legacyEntry -ExpectedInstallDir $ResolvedInstallDir -AllowVerifiedSource)) {
            Remove-ObjectProperty $mcpServers $legacyName
            Write-LogMessage "Removed superseded installer-owned '$legacyName' entry from $ConfigPath"
        }
    }

    $canonicalConfig = Join-Path $env:APPDATA "FoundryVTT MCP Bridge\foundry-servers.json"
    $entry = [ordered]@{
        command = Join-Path $ResolvedInstallDir "FoundryVTT MCP Bridge.exe"
        args = @((Join-Path $ResolvedInstallDir "resources\server\index.bundle.cjs"))
        env = [ordered]@{
            ELECTRON_RUN_AS_NODE = "1"
            FOUNDRY_SERVERS_CONFIG = $canonicalConfig
            FOUNDRY_MCP_MANAGED_BY = $OwnerId
        }
    }
    Set-ObjectPropertyValue $mcpServers $PrimaryEntryName $entry
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
    if (-not (Test-IsObjectMap $mcpServers)) {
        return $false
    }

    $removed = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $KnownEntryNames) {
        $entry = Get-ObjectPropertyValue $mcpServers $name
        if ((Test-ObjectPropertyExists $mcpServers $name) -and
            (Test-EntryOwnedByBridge -Entry $entry -ExpectedInstallDir $ResolvedInstallDir)) {
            Remove-ObjectProperty $mcpServers $name
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
