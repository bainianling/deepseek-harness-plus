# One-shot helper: replace the dsh web listener after the current agent turn has
# had time to persist. It runs outside the host process because killing that
# process from its own tool call would end the restart before a replacement starts.
$ErrorActionPreference = 'Stop'
$Repository = if ([string]::IsNullOrWhiteSpace($env:DSH_ROOT)) { $PSScriptRoot } else { $env:DSH_ROOT }
$StatusFile = Join-Path $Repository 'restart-status.txt'
$WebPort = 3080
$Pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($Pnpm)) { $Pnpm = (Get-Command pnpm -ErrorAction Stop).Source }

function Log([string]$Message) {
    try {
        Add-Content -Path $StatusFile -Value ("{0:o} {1}" -f (Get-Date), $Message)
    } catch { }
}

function Get-ListenerPids {
    $listeners = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
    return @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-WebReady {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        # The browser trust fence answers 401 to a bare probe once the server
        # is up; a refused connection is the only "not ready" signal.
        $status = $_.Exception.Response.StatusCode.value__
        return $status -eq 401
    }
}

function Wait-ForNoListener([int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ListenerPids).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (Get-ListenerPids).Count -eq 0
}

function Wait-ForWebReady([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-WebReady) { return $true }
        if ($Process.HasExited) {
            Log ("launch wrapper exited early with code {0}" -f $Process.ExitCode)
            return $false
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

Log 'restart script started'
try {
    # Let the initiating Agent flush its durable turn before the host disappears.
    Start-Sleep -Seconds 25

    $oldPids = @(Get-ListenerPids)
    if ($oldPids.Count -eq 0) {
        Log ("no listener found on port {0}; starting a replacement host" -f $WebPort)
    } else {
        foreach ($listenerPid in $oldPids) {
            Log ("stopping listener pid {0} on port {1}" -f $listenerPid, $WebPort)
            & taskkill.exe /PID $listenerPid /T /F 2>&1 | Out-Null
        }
        if (-not (Wait-ForNoListener 60)) {
            throw ("port {0} remained in use after stopping the previous listener" -f $WebPort)
        }
    }

    if (-not (Test-Path $Pnpm)) { throw "pnpm launcher not found: $Pnpm" }
    Log 'starting replacement dsh web host'
    $process = Start-Process -FilePath $Pnpm `
        -ArgumentList @('dsh', 'web', '--no-open') `
        -WorkingDirectory $Repository `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Repository 'dsh-web.log') `
        -RedirectStandardError (Join-Path $Repository 'dsh-web.err.log') `
        -PassThru
    Log ("launched wrapper pid {0}" -f $process.Id)

    if (Wait-ForWebReady $process 150) {
        $newPids = @(Get-ListenerPids)
        Log ("VERIFIED: http://127.0.0.1:{0}/ answers 200; listener pid(s): {1}" -f $WebPort, ($newPids -join ', '))
    } else {
        throw 'replacement host did not answer 200 within 150 seconds (see dsh-web.log and dsh-web.err.log)'
    }
} catch {
    Log ("FAILED: {0}" -f $_.Exception.Message)
}
