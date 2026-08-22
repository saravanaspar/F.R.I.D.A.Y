[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'saravanaspar/F.R.I.D.A.Y'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) {
    Write-Error "friday installer: $Message"
    exit 1
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Fail 'Native Windows releases are not published yet. Install/enable WSL2, then rerun this installer.'
}

& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
    Fail 'WSL2 is installed but not ready. Start/configure a Linux distribution, then rerun this installer.'
}

$InstallerUrl = "https://raw.githubusercontent.com/$Repository/main/scripts/install-release.sh"
# Repository is constrained by ValidatePattern, so it is safe to embed in this
# fixed POSIX command. The actual binary is installed inside the default WSL2
# distribution, where FRIDAY's POSIX private-file guarantees are enforced.
$Command = "command -v curl >/dev/null 2>&1 || { echo 'friday installer: curl is required inside WSL2' >&2; exit 1; }; curl --proto '=https' --tlsv1.2 -fsSL '$InstallerUrl' | sh -s -- '$Repository'"

Write-Host "Installing F.R.I.D.A.Y inside the default WSL2 Linux distribution..."
& wsl.exe sh -lc $Command
if ($LASTEXITCODE -ne 0) {
    Fail "WSL2 installer failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'F.R.I.D.A.Y was installed inside WSL2.'
Write-Host "Run setup from PowerShell with:  wsl sh -lc '$HOME/.local/bin/friday setup'"
Write-Host 'Or enter WSL2 and run:          friday setup'
