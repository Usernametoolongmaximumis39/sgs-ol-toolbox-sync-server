[CmdletBinding()]
param(
    [ValidatePattern('^[a-z][a-z0-9-]{0,30}$')][string]$ServiceName = 'sgs-toolbox-sync',
    [ValidateRange(1,65535)][int]$SyncPort = 17429,
    [ValidateRange(1,65535)][int]$AdminPort = 17430,
    [ValidateRange(1,65535)][int]$SetupPort = 17431,
    [string]$HostName,
    [switch]$ResetPassword
)

$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server'
$bundle = 'sgs-ol-toolbox-sync-server.tar.gz'
$nodeVersion = 'v24.20.0'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open 64-bit PowerShell as Administrator.'
}
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This installer requires x64 Windows and 64-bit PowerShell.' }
if ($SyncPort -eq $AdminPort -or $SetupPort -eq $SyncPort -or $SetupPort -eq $AdminPort) { throw 'Ports must differ.' }

$root = Join-Path $env:ProgramFiles $ServiceName
$data = Join-Path $root 'data'
$settingsFile = Join-Path $root 'install-settings.json'
$localService = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')

function Get-Download($Url, $Path) {
    & curl.exe --fail --silent --show-error --location --retry 3 --retry-connrefused --connect-timeout 15 --max-time 180 --proto '=https' --proto-redir '=https' --output $Path $Url
    if ($LASTEXITCODE) { throw "Download failed: $Url (curl $LASTEXITCODE)" }
}

function Assert-Checksum($Path, $Manifest, $Name) {
    $regex = '^([a-f0-9]{64})\s+' + [regex]::Escape($Name) + '$'
    $hashes = @(Get-Content -LiteralPath $Manifest | ForEach-Object {
        if ($_ -cmatch $regex) { $Matches[1] }
    })
    if ($hashes.Count -ne 1 -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $hashes[0]) {
        throw "SHA-256 mismatch: $Name. Retry after the release has finished publishing."
    }
}

function Protect-Root {
    $acl = Get-Acl -LiteralPath $root
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-19') {
        $sid = [Security.Principal.SecurityIdentifier]::new($identity)
        $rights = if ($sid -eq $localService) { 'ReadAndExecute' } else { 'FullControl' }
        $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    [void][IO.Directory]::CreateDirectory($data)
    $dataAcl = Get-Acl -LiteralPath $data
    $dataAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($localService, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $data -AclObject $dataAcl
}

function New-Password($Release, $Runtime) {
    $password = & $Runtime (Join-Path $Release 'tools\appearance-sync.mjs') --data-dir $data --reset-admin-password
    if ($LASTEXITCODE -or $password -cnotmatch '^A1[A-Za-z0-9_-]{43}$') { throw 'Password reset failed.' }
    return $password
}

function Start-Server($Release, $Runtime) {
    $entry = Join-Path $Release 'tools\appearance-sync.mjs'
    $arguments = '"{0}" --data-dir "{1}" --port {2} --admin-port {3} --private-network --public-network --https-admin' -f $entry, $data, $SyncPort, $AdminPort
    $arguments += " --http-admin --setup-port $SetupPort"
    if ($HostName) { $arguments += " --setup-host $HostName" }
    $action = New-ScheduledTaskAction -Execute $Runtime -Argument $arguments -WorkingDirectory $Release
    $account = $localService.Translate([Security.Principal.NTAccount]).Value
    $identity = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Principal $identity -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $ServiceName
}

function Stop-Server {
    Stop-ScheduledTask -TaskName $ServiceName
    for ($i = 0; $i -lt 30; $i++) {
        if ((Get-ScheduledTask -TaskName $ServiceName).State -ne 'Running') { return }
        Start-Sleep -Seconds 1
    }
    throw "Task $ServiceName failed to stop."
}

function Wait-Admin {
    for ($i = 0; $i -lt 30; $i++) {
        if ((Get-ScheduledTask -TaskName $ServiceName).State -eq 'Running') {
            $page = & curl.exe --fail --silent --noproxy '*' --max-time 2 "http://127.0.0.1:$AdminPort/admin/"
            if ($LASTEXITCODE -eq 0 -and $page -match 'id="login"') { return }
        }
        Start-Sleep -Seconds 1
    }
    throw "Startup check failed. Inspect Task Scheduler > $ServiceName."
}

function Show-Access {
    Write-Host ''
    Write-Host "Local recovery URL (on the server): http://127.0.0.1:$AdminPort/admin/"
    Write-Host "Initial sync TCP port: $SyncPort (loopback only)"
    Write-Host 'Public sync and HTTPS admin: configure a domain, certificate and separate TCP port in the panel (e.g. 8888).'
    Write-Host ("Password reset (Administrator PowerShell): & '{0}\install-windows.ps1' -ResetPassword -ServiceName '{1}'" -f $root, $ServiceName)
}

function Install-OrReset {
    $old = $null
    if (Test-Path -LiteralPath $settingsFile) {
        $old = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        $script:SyncPort = $old.syncPort
        $script:AdminPort = $old.adminPort
        $script:SetupPort = $old.setupPort
        $script:HostName = $old.setupHost
    } elseif ((Test-Path -LiteralPath $root) -or (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue)) {
        throw 'An unrelated installation path or task already exists. Choose another -ServiceName.'
    }
    if ($ResetPassword) {
        if (-not $old) { throw 'This instance is not installed.' }
        Stop-Server
        try { $password = New-Password $old.release $old.runtime }
        finally { Start-ScheduledTask -TaskName $ServiceName }
        Wait-Admin
        Show-Access
        Write-Host "New admin password: $password"
        return
    }

    if (-not $old) {
        $ports = @($SyncPort, $AdminPort, $SetupPort)
        if ($HostName) {
            $script:HostName = $HostName.ToLowerInvariant()
            $dns = '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
            $ipv4 = '^\d{1,3}(?:\.\d{1,3}){3}$'
            if ($HostName.Length -gt 253 -or $HostName -cnotmatch $dns -or
                ($HostName -match '^[0-9.]+$' -and ($HostName -notmatch $ipv4 -or
                    @($HostName.Split('.') | Where-Object { [int]$_ -gt 255 -or ([int]$_).ToString() -ne $_ }).Count))) {
                throw 'Invalid -HostName. Use a public IPv4 address or DNS name, without a scheme or port.'
            }
        }
        foreach ($port in $ports) {
            $address = if ($port -eq $SetupPort) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
            $listener = [Net.Sockets.TcpListener]::new($address, $port)
            try { $listener.Start() } finally { $listener.Stop() }
        }
    }
    $work = Join-Path ([IO.Path]::GetTempPath()) ("sgs-sync-" + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($work)
    $created = $false
    try {
        $download = "$repo/releases/latest/download"
        $archive = Join-Path $work $bundle
        $manifest = "$archive.sha256"
        Get-Download "$download/$bundle.sha256" $manifest
        Get-Download "$download/$bundle" $archive
        Assert-Checksum $archive $manifest $bundle
        $app = Join-Path $work 'app'
        [void][IO.Directory]::CreateDirectory($app)
        & tar.exe -xzf $archive -C $app
        if ($LASTEXITCODE) { throw 'Cannot extract the server archive.' }
        $version = (Get-Content -LiteralPath (Join-Path $app 'server-version.json') -Raw | ConvertFrom-Json).version
        if ($version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid server version.' }
        if ($old -and [version]$old.version -gt [version]$version) { throw 'Refusing to downgrade the server.' }
        if ($old -and $old.version -eq $version) {
            Start-ScheduledTask -TaskName $ServiceName
            Wait-Admin
            Show-Access
            Write-Host "Already on v$version. Existing password retained."
            return
        }

        $runtime = Join-Path $root "runtime\$nodeVersion\node.exe"
        if (-not (Test-Path -LiteralPath $runtime)) {
            $nodeName = "node-$nodeVersion-win-x64.zip"
            $nodeZip = Join-Path $work $nodeName
            $nodeHashes = Join-Path $work 'node.sha256'
            Get-Download "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" $nodeHashes
            Get-Download "https://nodejs.org/dist/$nodeVersion/$nodeName" $nodeZip
            Assert-Checksum $nodeZip $nodeHashes $nodeName
            Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $work 'node')
        }
        if (-not $old) {
            New-Item -ItemType Directory -Path $root | Out-Null
            $created = $true
            Protect-Root
        }
        if (-not (Test-Path -LiteralPath $runtime)) {
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $runtime))
            Copy-Item -LiteralPath (Join-Path $work "node\node-$nodeVersion-win-x64\node.exe") -Destination $runtime
        }
        $release = Join-Path $root ("releases\v$version-" + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($release)
        Get-ChildItem -LiteralPath $app -Force | Copy-Item -Destination $release -Recurse
        $control = Join-Path $root 'install-windows.ps1'
        Copy-Item -LiteralPath (Join-Path $release 'distribution\install-windows.ps1') -Destination $control -Force
        if (-not $old) { $password = New-Password $release $runtime }
        if (-not $old) {
            $setupCode = & $runtime (Join-Path $release 'tools\appearance-sync.mjs') --data-dir $data --create-setup-code
            if ($LASTEXITCODE -or $setupCode -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'Initial setup code creation failed.' }
        }
        if ($old) {
            $previousTask = Export-ScheduledTask -TaskName $ServiceName
            Stop-Server
        }
        try {
            Start-Server $release $runtime
            Wait-Admin
            if (-not $old) {
                $authority = if ($HostName) { $HostName } else { '127.0.0.1' }
                if ($SetupPort -ne 80) { $authority += ":${SetupPort}" }
                $firstPage = & curl.exe --fail --silent --noproxy '*' --max-time 5 -H "Host: $authority" "http://127.0.0.1:$SetupPort/admin/"
                if ($LASTEXITCODE -or -not ($firstPage -match 'data-initial-setup')) { throw 'The initial setup page failed its startup check.' }
            }
            @{ release = $release; runtime = $runtime; version = $version; syncPort = $SyncPort; adminPort = $AdminPort; setupHost = $HostName; setupPort = $SetupPort } |
                ConvertTo-Json | Set-Content -LiteralPath "$settingsFile.tmp" -Encoding UTF8
            if ($old) { [IO.File]::Replace("$settingsFile.tmp", $settingsFile, "$settingsFile.previous") }
            else { [IO.File]::Move("$settingsFile.tmp", $settingsFile) }
        } catch {
            if ($old) {
                Stop-Server
                Register-ScheduledTask -TaskName $ServiceName -Xml $previousTask -Force | Out-Null
                Start-ScheduledTask -TaskName $ServiceName
            }
            throw
        }
        $description = if ($old) { "Installed server v$version" } else { "Installed server v$version (private mode)" }
        Write-Host $description
        if (-not $old) {
            $shownHost = $HostName
            if (-not $shownHost) {
                $ip = & curl.exe -4fs --max-time 5 'https://api.ipify.org'
                $parsed = $null
                if ($LASTEXITCODE -eq 0 -and [Net.IPAddress]::TryParse([string]$ip, [ref]$parsed) -and
                    $parsed.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { $shownHost = $parsed.ToString() }
                else { $shownHost = 'SERVER_PUBLIC_IP_OR_DNS' }
            }
            Write-Host "HTTP admin link: http://${shownHost}:$SetupPort/admin/"
            Write-Host "HTTP admin TCP port: $SetupPort (allow your public client IP in the cloud and Windows firewalls)"
            Write-Host "First setup code: $setupCode"
            Write-Host 'The setup code lasts 60 minutes. The HTTP admin link stays active.'
        }
        Show-Access
        if ($old) { Write-Host 'Existing password retained.' }
        else { Write-Host "Initial admin password: $password" }
    } catch {
        if ($created -and -not (Test-Path -LiteralPath $settingsFile)) {
            if (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue) {
                Stop-Server
                Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
            }
            $ownedRoot = (Resolve-Path -LiteralPath $root).ProviderPath
            if ($ownedRoot -eq $root -and (Split-Path -Parent $ownedRoot) -eq $env:ProgramFiles) {
                Remove-Item -LiteralPath $ownedRoot -Recurse -Force
            }
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    }
}

$lock = [Threading.Mutex]::new($false, "Global\$ServiceName-install")
try {
    if (-not $lock.WaitOne(0)) { throw 'An install or password reset is already running.' }
    try { Install-OrReset } finally { $lock.ReleaseMutex() }
} finally { $lock.Dispose() }
