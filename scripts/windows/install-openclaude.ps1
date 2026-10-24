$ErrorActionPreference = 'Stop'

$repository = 'https://github.com/LightningEX19/openclaude.git'
$branch = 'lightningex19-llama-windows-provider'
$installDirectory = Join-Path $env:LOCALAPPDATA 'OpenClaude-Fork'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22 or newer is required. Install it from https://nodejs.org/ and run this installer again.'
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required; found $((node --version))."
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git is required. Install it from https://git-scm.com/download/win and run this installer again.'
}

if (Test-Path $installDirectory) {
  if (-not (Test-Path (Join-Path $installDirectory '.git'))) {
    throw "The install directory already exists and is not a Git repository: $installDirectory"
  }

  $currentBranch = git -C $installDirectory branch --show-current
  if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $branch) {
    throw "The existing checkout at $installDirectory is not on '$branch'. Move it aside before reinstalling."
  }

  $changes = git -C $installDirectory status --porcelain
  if ($LASTEXITCODE -ne 0 -or $changes) {
    throw "The existing checkout has local changes. Preserve or move it before reinstalling: $installDirectory"
  }

  git -C $installDirectory pull --ff-only origin $branch
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not update the OpenClaude fork checkout.'
  }
} else {
  git clone --depth 1 --branch $branch $repository $installDirectory
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not clone the OpenClaude fork.'
  }
}

Push-Location $installDirectory
try {
  npx.cmd --yes bun@1.4.3 install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation failed.'
  }

  npx.cmd --yes bun@1.4.3 run build
  if ($LASTEXITCODE -ne 0) {
    throw 'OpenClaude build failed.'
  }

  npm.cmd link
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not link OpenClaude into the global npm command path.'
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'OpenClaude is installed. Start it with: openclaude.cmd (or openclaude if PowerShell script execution is enabled).'
Write-Host 'To configure Llama for Windows, run /provider and choose Llama for Windows.'
