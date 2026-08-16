param(
    [Parameter(Mandatory = $false)]
    [string]$InstallDir,

    [Parameter(Mandatory = $false)]
    [int]$ControlPort = 31414,

    [Parameter(Mandatory = $false)]
    [ValidateRange(2, 120)]
    [int]$TimeoutSeconds = 20,

    [Parameter(Mandatory = $false)]
    [switch]$AllowLegacyIdentity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ControlHost = "127.0.0.1"
$ProductExecutable = "FoundryVTT MCP Bridge.exe"
$LegacyRootShortcutName = "FoundryVTT MCP Bridge.lnk"

if ($null -eq ("FoundryVttMcp.CommandLine" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace FoundryVttMcp {
    public static class CommandLine {
        [DllImport("shell32.dll", SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(
            [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
            out int argumentCount
        );

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static string[] Split(string commandLine) {
            if (String.IsNullOrWhiteSpace(commandLine)) return new string[0];
            int count;
            IntPtr values = CommandLineToArgvW(commandLine, out count);
            if (values == IntPtr.Zero) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            try {
                var result = new List<string>(count);
                for (int index = 0; index < count; index++) {
                    IntPtr value = Marshal.ReadIntPtr(values, index * IntPtr.Size);
                    result.Add(Marshal.PtrToStringUni(value));
                }
                return result.ToArray();
            }
            finally {
                LocalFree(values);
            }
        }
    }
}
"@
}

function Write-ShutdownLog {
    param([string]$Message)
    Write-Output "[bridge-shutdown] $Message"
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
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
}

function Test-IsWithinRoot {
    param([string]$Candidate, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) {
        return $false
    }
    $fullCandidate = (Convert-ToFullPath $Candidate).TrimEnd("\")
    $fullRoot = (Convert-ToFullPath $Root).TrimEnd("\")
    return (
        [string]::Equals($fullCandidate, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullCandidate.StartsWith("$fullRoot\", [System.StringComparison]::OrdinalIgnoreCase)
    )
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

function Invoke-ControlRequest {
    param([Parameter(Mandatory = $true)][string]$Method)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.BeginConnect($ControlHost, $ControlPort, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(750)) {
            throw "Control connection timed out"
        }
        $client.EndConnect($connect)
        $client.ReceiveTimeout = 2000
        $client.SendTimeout = 2000
        $stream = $client.GetStream()
        $id = "installer-$Method-$([Guid]::NewGuid().ToString('N'))"
        $request = @{ id = $id; method = $Method; params = @{} } | ConvertTo-Json -Compress
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes("$request`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false))
        $line = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) {
            throw "Control server returned an empty response"
        }
        $response = $line | ConvertFrom-Json
        if ((Get-ObjectPropertyValue $response "id") -ne $id -or
            $null -eq (Get-ObjectPropertyValue $response "result")) {
            throw "Control server returned an invalid response"
        }
        return (Get-ObjectPropertyValue $response "result")
    }
    finally {
        $client.Dispose()
    }
}

function Get-ExactApplicationProcesses {
    param([string]$ExecutablePath)
    if ([string]::IsNullOrWhiteSpace($ExecutablePath) -or
        -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        return @()
    }
    $expected = Convert-ToFullPath $ExecutablePath
    $wrapperScript = Join-Path (Split-Path -Parent $expected) "resources\server\index.bundle.cjs"
    try {
        return @(
            Get-CimInstance Win32_Process -Filter "Name = '$ProductExecutable'" |
                Where-Object {
                    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath) -or
                        -not [string]::Equals(
                        (Convert-ToFullPath $_.ExecutablePath),
                        $expected,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )) {
                        return $false
                    }
                    # ELECTRON_RUN_AS_NODE wrappers intentionally use the same
                    # GUI-subsystem executable so MCP clients never flash a
                    # console. Do not mistake that exact script invocation for
                    # the desktop/tray process.
                    try {
                        $arguments = @([FoundryVttMcp.CommandLine]::Split([string]$_.CommandLine))
                        if ($arguments.Count -ge 2 -and
                            (Test-PathEqual ([string]$arguments[1]) $wrapperScript)) {
                            return $false
                        }
                    }
                    catch {
                        return $false
                    }
                    return $true
                }
        )
    }
    catch {
        Write-ShutdownLog "Could not enumerate the exact desktop process: $($_.Exception.Message)"
        return @()
    }
}

function Get-ExactOwnedWrapperProcesses {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) {
        return @()
    }

    $layouts = [System.Collections.Generic.List[object]]::new()
    $layouts.Add([PSCustomObject]@{
        Executable = Join-Path $Root $ProductExecutable
        Script = Join-Path $Root "resources\server\index.bundle.cjs"
        Kind = "current"
    })
    $layouts.Add([PSCustomObject]@{
        Executable = Join-Path $Root "runtime\node.exe"
        Script = Join-Path $Root "resources\server\index.bundle.cjs"
        Kind = "previous"
    })
    if ($AllowLegacyIdentity.IsPresent -and
        (Test-Path -LiteralPath (Join-Path $Root "node.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Root "Uninstall.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (
            Join-Path $Root "foundry-mcp-server\packages\mcp-server\dist\index.cjs"
        ) -PathType Leaf)) {
        $layouts.Add([PSCustomObject]@{
            Executable = Join-Path $Root "node.exe"
            Script = Join-Path $Root "foundry-mcp-server\packages\mcp-server\dist\index.cjs"
            Kind = "legacy"
        })
    }

    try {
        $wrapperProcesses = @(
            Get-CimInstance Win32_Process |
                Where-Object {
                    $_.Name -ieq "node.exe" -or $_.Name -ieq $ProductExecutable
                }
        )
    }
    catch {
        throw "Could not enumerate bridge wrapper processes for exact ownership checks: $($_.Exception.Message)"
    }

    $owned = [System.Collections.Generic.List[object]]::new()
    foreach ($process in $wrapperProcesses) {
        if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
            [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
            continue
        }
        foreach ($layout in $layouts) {
            if (-not (Test-PathEqual $process.ExecutablePath $layout.Executable)) {
                continue
            }
            try {
                $arguments = @([FoundryVttMcp.CommandLine]::Split([string]$process.CommandLine))
            }
            catch {
                Write-ShutdownLog "Could not parse command line for PID $($process.ProcessId); leaving it running"
                continue
            }
            if ($arguments.Count -lt 2 -or
                -not (Test-PathEqual ([string]$arguments[1]) $layout.Script)) {
                continue
            }
            $owned.Add([PSCustomObject]@{
                Process = $process
                Kind = $layout.Kind
                Executable = $layout.Executable
                Script = $layout.Script
            })
            break
        }
    }
    return @($owned)
}

function Stop-ExactOwnedWrappers {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) {
        return
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $quietChecks = 0
    do {
        $owned = @(Get-ExactOwnedWrapperProcesses $Root)
        if ($owned.Count -eq 0) {
            $quietChecks++
            if ($quietChecks -ge 3) {
                Write-ShutdownLog "No installer-owned stdio wrapper remains"
                return
            }
            Start-Sleep -Milliseconds 200
            continue
        }

        $quietChecks = 0
        foreach ($wrapper in $owned) {
            $processId = [int]$wrapper.Process.ProcessId
            Write-ShutdownLog (
                "Stopping exact $($wrapper.Kind) stdio wrapper PID $processId " +
                "($($wrapper.Executable) -> $($wrapper.Script))"
            )
            $result = Invoke-CimMethod -InputObject $wrapper.Process -MethodName Terminate
            if ($null -eq $result -or [int]$result.ReturnValue -ne 0) {
                $returnValue = if ($null -eq $result) { "no result" } else { $result.ReturnValue }
                throw "Exact owned wrapper PID $processId could not be stopped (CIM result: $returnValue)"
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Installer-owned stdio wrappers kept restarting. Close the owning MCP clients and retry."
}

function Stop-DesktopApplicationGracefully {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) {
        return
    }
    $applicationPath = Join-Path $Root $ProductExecutable
    $processes = @(Get-ExactApplicationProcesses $applicationPath)
    if ($processes.Count -eq 0) {
        Write-ShutdownLog "No running desktop process belongs to $applicationPath"
        return
    }

    Write-ShutdownLog "Requesting graceful desktop shutdown through the installed executable"
    $requestProcess = Start-Process -FilePath $applicationPath `
        -ArgumentList "--shutdown-for-update" `
        -PassThru `
        -Wait `
        -WindowStyle Hidden
    if ($requestProcess.ExitCode -ne 0) {
        throw "Desktop shutdown request returned exit code $($requestProcess.ExitCode)"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (@(Get-ExactApplicationProcesses $applicationPath).Count -eq 0) {
            Write-ShutdownLog "Desktop application exited cleanly"
            return
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Desktop application did not exit within $TimeoutSeconds seconds. Close it from the notification area and retry."
}

function Test-BackendOwnedByInstall {
    param([object]$Ping, [string]$Root)
    if ($null -eq $Ping -or
        (Get-ObjectPropertyValue $Ping "ok") -ne $true -or
        [string]::IsNullOrWhiteSpace($Root)) {
        return $false
    }
    $reportedEntryPath = [string](Get-ObjectPropertyValue $Ping "entryPath")
    if (-not [string]::IsNullOrWhiteSpace($reportedEntryPath)) {
        $entryPath = Convert-ToFullPath $reportedEntryPath
        return (
            (Test-IsWithinRoot $entryPath (Join-Path $Root "resources\server")) -or
            (Test-IsWithinRoot $entryPath (Join-Path $Root "foundry-mcp-server"))
        )
    }
    return $AllowLegacyIdentity.IsPresent
}

function Stop-OwnedBackendGracefully {
    param([string]$Root)
    try {
        $ping = Invoke-ControlRequest -Method "ping"
    }
    catch {
        Write-ShutdownLog "No bridge backend is listening on $ControlHost`:$ControlPort"
        return
    }

    if (-not (Test-BackendOwnedByInstall -Ping $ping -Root $Root)) {
        Write-ShutdownLog "Control port belongs to a different or unverifiable process; leaving it running"
        return
    }

    $instanceId = [string](Get-ObjectPropertyValue $ping "instanceId")
    Write-ShutdownLog "Requesting graceful backend shutdown for instance $instanceId"
    $shutdown = Invoke-ControlRequest -Method "shutdown"
    if ((Get-ObjectPropertyValue $shutdown "ok") -ne $true) {
        throw "Backend rejected the shutdown request"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 200
        try {
            $current = Invoke-ControlRequest -Method "ping"
            if (-not [string]::IsNullOrWhiteSpace($instanceId) -and
                [string](Get-ObjectPropertyValue $current "instanceId") -ne $instanceId) {
                Write-ShutdownLog "Original backend instance exited"
                return
            }
        }
        catch {
            Write-ShutdownLog "Backend control listener closed cleanly"
            return
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Bridge backend did not exit within $TimeoutSeconds seconds"
}

function Remove-ExactLegacyRootShortcut {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        return
    }
    $shortcutPath = Join-Path $env:APPDATA (
        "Microsoft\Windows\Start Menu\Programs\" + $LegacyRootShortcutName
    )
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
        return
    }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $expectedTarget = Join-Path $Root $ProductExecutable
        if (Test-PathEqual ([string]$shortcut.TargetPath) $expectedTarget) {
            [System.IO.File]::Delete($shortcutPath)
            Write-ShutdownLog "Removed the exact obsolete root Start Menu shortcut"
        }
        else {
            Write-ShutdownLog "A same-name root Start Menu shortcut is foreign; leaving it unchanged"
        }
    }
    catch {
        Write-ShutdownLog "Could not inspect the obsolete root Start Menu shortcut; leaving it unchanged"
    }
}

try {
    $resolvedInstallDir = Convert-ToFullPath $InstallDir
    Stop-DesktopApplicationGracefully $resolvedInstallDir
    Stop-ExactOwnedWrappers $resolvedInstallDir
    Stop-OwnedBackendGracefully $resolvedInstallDir
    Remove-ExactLegacyRootShortcut $resolvedInstallDir
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
