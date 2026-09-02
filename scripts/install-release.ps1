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

$InstallerUrl = "https://github.com/$Repository/releases/latest/download/install-release.sh"
# The bootstrap installer is itself a release artifact. Build the WSL command
# from a literal here-string so PowerShell never expands shell variables such as
# $tmp or command substitutions before WSL receives them. Repository is bounded
# by ValidatePattern above, so placeholder substitution cannot inject shell syntax.
$Command = @'
set -eu
command -v curl >/dev/null 2>&1 || { echo 'friday installer: curl is required inside WSL2' >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo 'friday installer: GitHub CLI (gh) is required inside WSL2' >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL '__INSTALLER_URL__' -o "$tmp"
gh attestation verify "$tmp" --repo '__REPOSITORY__' --cert-identity 'https://github.com/__REPOSITORY__/.github/workflows/release.yml@refs/heads/main' --source-ref 'refs/heads/main' --deny-self-hosted-runners >/dev/null
sh "$tmp" '__REPOSITORY__'
'@
$Command = $Command.Replace('__INSTALLER_URL__', $InstallerUrl).Replace('__REPOSITORY__', $Repository)

Write-Host "Installing F.R.I.D.A.Y inside the default WSL2 Linux distribution..."
& wsl.exe sh -lc $Command
if ($LASTEXITCODE -ne 0) {
    Fail "WSL2 installer failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'F.R.I.D.A.Y was installed inside WSL2.'
Write-Host "Run setup from PowerShell with:  wsl sh -lc '$HOME/.local/bin/friday setup'"
Write-Host 'Or enter WSL2 and run:          friday setup'
