param(
    [Parameter(Mandatory=$false)]
    [string]$InstallDir,

    [Parameter(Mandatory=$false)]
    [switch]$Remove
)

# Configure Claude Desktop for Foundry MCP Server
# This script safely merges MCP server configuration into existing Claude Desktop config

$ErrorActionPreference = "Stop"

# Enhanced logging with file output
$LogFile = Join-Path $env:TEMP "foundry-mcp-claude-config.log"

function Write-LogMessage {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    Write-Host $logEntry
    Add-Content -Path $LogFile -Value $logEntry -ErrorAction SilentlyContinue
}

function Test-JsonValid {
    param([string]$JsonString)
    try {
        $JsonString | ConvertFrom-Json | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Get-ClaudeConfigTargets {
    # Returns the list of Claude Desktop config directories to configure.
    #
    # Standalone Claude Desktop reads %APPDATA%\Claude\.
    # The Microsoft Store (MSIX) build is filesystem-virtualised and reads
    # from a sandboxed container instead:
    #   %LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\Claude\
    # Writing only to %APPDATA% silently fails for Store installs (issue #40),
    # so we configure every location that exists (or plausibly should).

    $targets = [System.Collections.Generic.List[object]]::new()

    # 1. Standard standalone path (always a candidate)
    $standardDir = Join-Path $env:APPDATA "Claude"
    $targets.Add([PSCustomObject]@{
        Kind   = "Standalone"
        Dir    = $standardDir
        Create = $true   # safe to create if missing — standalone reads it
    })

    # 2. MSIX virtualised path(s). The package family name contains "Claude"
    #    but the exact id varies, so glob for it.
    $packagesRoot = Join-Path $env:LOCALAPPDATA "Packages"
    if (Test-Path $packagesRoot) {
        $claudePackages = Get-ChildItem -Path $packagesRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*Claude*" }
        foreach ($pkg in $claudePackages) {
            $virtualDir = Join-Path $pkg.FullName "LocalCache\Roaming\Claude"
            $targets.Add([PSCustomObject]@{
                Kind   = "MSIX ($($pkg.Name))"
                Dir    = $virtualDir
                # Only create if the package's LocalCache\Roaming exists — that
                # confirms it's a real installed Claude container, not noise.
                Create = (Test-Path (Join-Path $pkg.FullName "LocalCache\Roaming"))
            })
        }
    }

    return $targets
}

function Get-ConfigFileState {
    param([string]$ConfigPath)

    if (-not (Test-Path $ConfigPath)) {
        return "Missing"
    }
    
    $content = Get-Content $ConfigPath -Raw -ErrorAction SilentlyContinue
    if (-not $content) {
        return "Empty"
    }
    
    $content = $content.Trim()
    
    # Check for common corruption patterns
    if ($content -eq "{") {
        return "PartialOpen"
    }
    if ($content -eq "}") {
        return "PartialClose" 
    }
    if ($content.StartsWith("{") -and -not $content.EndsWith("}")) {
        return "IncompleteJSON"
    }
    if (-not $content.StartsWith("{")) {
        return "InvalidFormat"
    }
    
    # Test if it's valid JSON
    if (Test-JsonValid $content) {
        return "ValidJSON"
    }
    else {
        return "CorruptedJSON"
    }
}


function Set-FoundryMcpConfig {
    param(
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        [Parameter(Mandatory=$true)][string]$NodeExe,
        [Parameter(Mandatory=$true)][string]$McpServer
    )

    # Analyze and handle existing configuration
    $config = $null
    $backupPath = $null

    $fileState = Get-ConfigFileState $ConfigPath
    Write-LogMessage "Claude config file state: $fileState"

    switch ($fileState) {
        "Missing" {
            Write-LogMessage "No existing configuration found, creating new..."
            $config = [PSCustomObject]@{
                mcpServers = [PSCustomObject]@{}
            }
        }
        
        { $_ -in "Empty", "PartialOpen", "PartialClose", "IncompleteJSON", "InvalidFormat", "CorruptedJSON" } {
            Write-LogMessage "Configuration file is corrupted ($fileState), recreating from scratch..."
            
            # Create backup of corrupted file for troubleshooting
            if (Test-Path $configPath) {
                $backupPath = "$configPath.corrupted-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                Copy-Item $configPath $backupPath
                Write-LogMessage "Backed up corrupted file: $backupPath"
            }
            
            # Create fresh configuration
            $config = [PSCustomObject]@{
                mcpServers = [PSCustomObject]@{}
            }
        }
        
        "ValidJSON" {
            Write-LogMessage "Reading existing valid configuration..."
            
            # Create backup
            $backupPath = "$configPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item $configPath $backupPath
            Write-LogMessage "Created backup: $backupPath"
            
            try {
                $configContent = Get-Content $configPath -Raw
                $config = $configContent | ConvertFrom-Json
                Write-LogMessage "Existing configuration loaded successfully"
                
                # Log basic structure (not full content to avoid huge logs)
                $propCount = $config.PSObject.Properties.Name.Count
                Write-LogMessage "Configuration has $propCount top-level properties"
            }
            catch {
                Write-LogMessage "Failed to parse supposedly valid JSON, recreating..." "ERROR"
                $config = [PSCustomObject]@{
                    mcpServers = [PSCustomObject]@{}
                }
            }
        }
    }
    
    # Ensure mcpServers section exists and is valid
    if (-not $config.PSObject.Properties.Name -contains "mcpServers" -or $null -eq $config.mcpServers) {
        Write-LogMessage "Adding mcpServers section to configuration..."
        if ($config.PSObject.Properties.Name -contains "mcpServers") {
            $config.mcpServers = [PSCustomObject]@{}
        } else {
            $config | Add-Member -Type NoteProperty -Name "mcpServers" -Value ([PSCustomObject]@{})
        }
    }
    
    # Configure Foundry MCP Server
    Write-LogMessage "Configuring Foundry MCP Server..."
    
    $foundryMcpConfig = [PSCustomObject]@{
        command = $nodeExe
        args = @($mcpServer)
        env = [PSCustomObject]@{}
    }
    
    # Add or update foundry-mcp server configuration
    if ($config.mcpServers.PSObject.Properties.Name -contains "foundry-mcp") {
        Write-LogMessage "Updating existing foundry-mcp configuration..."
        $config.mcpServers."foundry-mcp" = $foundryMcpConfig
    }
    else {
        Write-LogMessage "Adding new foundry-mcp configuration..."
        $config.mcpServers | Add-Member -Type NoteProperty -Name "foundry-mcp" -Value $foundryMcpConfig
    }
    
    # Convert to JSON with proper formatting for Claude Desktop
    Write-LogMessage "Generating new configuration JSON..."
    
    # Use PowerShell's ConvertTo-Json - it handles escaping correctly
    $newConfigJson = $config | ConvertTo-Json -Depth 10
    
    # Validate generated JSON
    if (-not (Test-JsonValid $newConfigJson)) {
        throw "Generated configuration JSON is invalid"
    }
    
    Write-LogMessage "Generated configuration validated"
    
    # Write new configuration
    try {
        # Use UTF8 without BOM for better compatibility
        [System.IO.File]::WriteAllText($configPath, $newConfigJson, [System.Text.UTF8Encoding]::new($false))
        Write-LogMessage "Claude Desktop configuration updated successfully"
    }
    catch {
        # Restore backup if write failed
        if ($backupPath -and (Test-Path $backupPath)) {
            Write-LogMessage "Write failed, restoring backup..."
            Copy-Item $backupPath $configPath -Force
        }
        throw "Failed to write Claude Desktop configuration: $($_.Exception.Message)"
    }
    
    # Verify written file is valid
    try {
        $verification = Get-Content $configPath -Raw | ConvertFrom-Json
        Write-LogMessage "Written configuration verified"
    }
    catch {
        # Restore backup if verification failed
        if ($backupPath -and (Test-Path $backupPath)) {
            Write-LogMessage "Verification failed, restoring backup..."
            Copy-Item $backupPath $configPath -Force
        }
        throw "Written configuration file is invalid: $($_.Exception.Message)"
    }

    Write-LogMessage "Configuration written and verified for: $configPath"
}

function Remove-FoundryMcpConfig {
    param([Parameter(Mandatory=$true)][string]$ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return $false
    }

    $fileState = Get-ConfigFileState $ConfigPath
    if ($fileState -ne "ValidJSON") {
        throw "Claude Desktop configuration is not valid JSON and was left unchanged: $ConfigPath"
    }

    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if (-not $config -or -not ($config -is [PSCustomObject])) {
        throw "Claude Desktop configuration root is not a JSON object and was left unchanged: $ConfigPath"
    }

    if (-not ($config.PSObject.Properties.Name -contains "mcpServers") -or
        $null -eq $config.mcpServers -or
        -not ($config.mcpServers -is [PSCustomObject])) {
        Write-LogMessage "No MCP server object found in: $ConfigPath"
        return $false
    }

    $entryNames = @("foundry-mcp", "foundry-vtt-mcp")
    $removedNames = [System.Collections.Generic.List[string]]::new()
    foreach ($entryName in $entryNames) {
        if ($config.mcpServers.PSObject.Properties.Name -contains $entryName) {
            $config.mcpServers.PSObject.Properties.Remove($entryName)
            $removedNames.Add($entryName)
        }
    }

    if ($removedNames.Count -eq 0) {
        Write-LogMessage "No Foundry MCP entry found in: $ConfigPath"
        return $false
    }

    $backupPath = "$ConfigPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')"
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
    Write-LogMessage "Created backup: $backupPath"

    $newConfigJson = $config | ConvertTo-Json -Depth 100
    if (-not (Test-JsonValid $newConfigJson)) {
        throw "Generated configuration JSON is invalid; the original file was left unchanged"
    }

    $temporaryPath = "$ConfigPath.tmp-$PID"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $newConfigJson,
            [System.Text.UTF8Encoding]::new($false)
        )
        Get-Content -LiteralPath $temporaryPath -Raw | ConvertFrom-Json | Out-Null
        Move-Item -LiteralPath $temporaryPath -Destination $ConfigPath -Force
    }
    catch {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        throw
    }

    Write-LogMessage "Removed only $($removedNames -join ', ') from: $ConfigPath"
    return $true
}

try {
    Write-LogMessage "=============================================="
    Write-LogMessage "Starting Claude Desktop configuration..."
    Write-LogMessage "=============================================="
    Write-LogMessage "Log file location: $LogFile"
    Write-LogMessage "PowerShell version: $($PSVersionTable.PSVersion)"
    Write-LogMessage "Current user: $($env:USERNAME)"
    Write-LogMessage "Install directory: $InstallDir"
    Write-LogMessage "APPDATA: $($env:APPDATA)"
    Write-LogMessage "Script parameters: $($PSBoundParameters | ConvertTo-Json)"

    if ($Remove) {
        Write-LogMessage "Removing Foundry MCP entries from every existing Claude Desktop configuration target..."
        $targets = Get-ClaudeConfigTargets
        $removedCount = 0
        $failures = [System.Collections.Generic.List[string]]::new()

        foreach ($target in $targets) {
            $configPath = Join-Path $target.Dir "claude_desktop_config.json"
            if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
                Write-LogMessage "No configuration file for $($target.Kind); skipping: $configPath"
                continue
            }

            try {
                if (Remove-FoundryMcpConfig -ConfigPath $configPath) {
                    $removedCount++
                }
            }
            catch {
                Write-LogMessage "Failed to update $($target.Kind): $($_.Exception.Message)" "ERROR"
                $failures.Add("$($target.Kind): $($_.Exception.Message)")
            }
        }

        Write-LogMessage "Removed Foundry MCP entries from $removedCount configuration file(s)."
        if ($failures.Count -gt 0) {
            throw "One or more Claude Desktop configurations were left unchanged: $($failures -join '; ')"
        }

        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        throw "InstallDir is required unless -Remove is used"
    }
    
    # Validate installation directory exists
    if (-not (Test-Path $InstallDir)) {
        throw "Installation directory does not exist: $InstallDir"
    }
    
    # Validate required files exist
    $nodeExe = Join-Path $InstallDir "node.exe"
    $mcpServer = Join-Path $InstallDir "foundry-mcp-server\packages\mcp-server\dist\index.cjs"
    
    if (-not (Test-Path $nodeExe)) {
        throw "Node.js executable not found: $nodeExe"
    }
    
    if (-not (Test-Path $mcpServer)) {
        throw "MCP server not found: $mcpServer"
    }
    
    Write-LogMessage "Installation files validated"

    # Determine all Claude Desktop config locations (standalone + MSIX/Store)
    $targets = Get-ClaudeConfigTargets
    Write-LogMessage "Discovered $($targets.Count) potential Claude config location(s)"

    $configuredCount = 0
    $skippedCount = 0
    $failures = [System.Collections.Generic.List[string]]::new()

    foreach ($target in $targets) {
        $claudeConfigDir = $target.Dir
        $configPath = Join-Path $claudeConfigDir "claude_desktop_config.json"

        Write-LogMessage "----------------------------------------------"
        Write-LogMessage "Target: $($target.Kind)"
        Write-LogMessage "Claude config path: $configPath"

        $dirExists = Test-Path $claudeConfigDir
        if (-not $dirExists) {
            if (-not $target.Create) {
                Write-LogMessage "Directory missing and not eligible for creation, skipping this target."
                $skippedCount++
                continue
            }
            Write-LogMessage "Creating Claude Desktop directory..."
            try {
                New-Item -ItemType Directory -Path $claudeConfigDir -Force | Out-Null
            }
            catch {
                Write-LogMessage "Failed to create directory: $($_.Exception.Message)" "ERROR"
                $failures.Add("$($target.Kind): could not create config directory")
                continue
            }
        }

        try {
            Set-FoundryMcpConfig -ConfigPath $configPath -NodeExe $nodeExe -McpServer $mcpServer
            $configuredCount++
            Write-LogMessage "Configured: $($target.Kind)"
        }
        catch {
            Write-LogMessage "Failed to configure $($target.Kind): $($_.Exception.Message)" "ERROR"
            $failures.Add("$($target.Kind): $($_.Exception.Message)")
        }
    }

    Write-LogMessage "=============================================="
    Write-LogMessage "Configured $configuredCount location(s), skipped $skippedCount."

    if ($configuredCount -eq 0) {
        throw "No Claude Desktop configuration locations could be configured. Failures: $($failures -join '; ')"
    }

    if ($failures.Count -gt 0) {
        Write-LogMessage "Some locations failed but at least one succeeded: $($failures -join '; ')" "WARN"
    }

    Write-LogMessage "Claude Desktop configuration completed successfully"
    Write-LogMessage "Please restart Claude Desktop to load the new configuration"

    exit 0
}
catch {
    $errorMsg = $_.Exception.Message
    Write-LogMessage "Configuration failed: $errorMsg" "ERROR"
    Write-LogMessage "Full exception details: $($_.Exception | ConvertTo-Json -Depth 3)" "ERROR"
    Write-LogMessage "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    if ($Remove) {
        Write-LogMessage "Failed targets were left unchanged; other targets may already have been cleaned and backed up" "ERROR"
    }
    else {
        Write-LogMessage "The Claude Desktop configuration was not modified" "ERROR"
    }
    Write-LogMessage "=============================================="
    Write-LogMessage "For detailed error information, check: $LogFile" "ERROR"
    Write-LogMessage "=============================================="

    # Provide concise error message for NSIS/user display
    $shortError = switch -Wildcard ($errorMsg) {
        "*MCP server not found*" { "MCP server files missing from installation" }
        "*Node.js executable not found*" { "Node.js runtime missing from installation" }
        "*Installation directory does not exist*" { "Installation directory not found" }
        "*Cannot bind argument*" { "Claude Desktop configuration format error" }
        "*ConvertFrom-Json*" { "Claude Desktop configuration file corrupted" }
        "*Access*denied*" { "Permission denied accessing Claude Desktop configuration" }
        Default { "Claude Desktop configuration failed" }
    }

    Write-Error "$shortError. Details in log: $LogFile"
    exit 1
}
