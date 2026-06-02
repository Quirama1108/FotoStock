param(
  [string]$Region = "us-east-1",
  [string]$FunctionName = "fotostock-api",
  [string]$RoleName = "fotostock-lambda-role"
)

$ErrorActionPreference = "Stop"

$BackendDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $BackendDir ".env.local"
$ZipPath = Join-Path $BackendDir "fotostock-lambda.zip"
$TrustPolicyPath = Join-Path $BackendDir "lambda-trust-policy.json"
$EnvJsonPath = Join-Path ([System.IO.Path]::GetTempPath()) "fotostock-lambda-env.json"

function Invoke-AwsJson {
  param([string[]]$ArgsList)

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & aws @ArgsList 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }

  if ($code -ne 0) {
    throw (($output | ForEach-Object { $_.ToString() }) -join "`n")
  }
  if (-not $output) {
    return $null
  }
  return (($output | ForEach-Object { $_.ToString() }) -join "`n") | ConvertFrom-Json
}

function Invoke-Aws {
  param([string[]]$ArgsList)

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & aws @ArgsList 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }

  if ($code -ne 0) {
    throw (($output | ForEach-Object { $_.ToString() }) -join "`n")
  }
  return $output
}

function Test-AwsResource {
  param([string[]]$ArgsList)

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $null = & aws @ArgsList *> $null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }

  return $code -eq 0
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "No existe backend/.env.local"
}

$envMap = @{}
Get-Content -LiteralPath $EnvPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $idx = $line.IndexOf("=")
  if ($idx -lt 1) { return }
  $key = $line.Substring(0, $idx).Trim()
  $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
  $envMap[$key] = $value
}

foreach ($required in @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET")) {
  if (-not $envMap.ContainsKey($required) -or [string]::IsNullOrWhiteSpace($envMap[$required])) {
    throw "Falta $required en backend/.env.local"
  }
}

@'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
'@ | Set-Content -LiteralPath $TrustPolicyPath -Encoding ascii

$roleArn = $null
$roleExists = Test-AwsResource @("iam", "get-role", "--role-name", $RoleName)

if ($roleExists) {
  $role = Invoke-AwsJson @("iam", "get-role", "--role-name", $RoleName)
  $roleArn = $role.Role.Arn
  Write-Host "Rol IAM existente: $roleArn"
} else {
  Write-Host "Creando rol IAM $RoleName..."
  $role = Invoke-AwsJson @(
    "iam", "create-role",
    "--role-name", $RoleName,
    "--assume-role-policy-document", "file://$TrustPolicyPath"
  )
  $roleArn = $role.Role.Arn

  Invoke-Aws @(
    "iam", "attach-role-policy",
    "--role-name", $RoleName,
    "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  ) | Out-Null

  Write-Host "Esperando propagacion del rol..."
  Start-Sleep -Seconds 12
}

if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

Compress-Archive -LiteralPath (Join-Path $BackendDir "lambda.mjs") -DestinationPath $ZipPath -Force

$envPayload = @{
  Variables = @{
    SUPABASE_URL = $envMap["SUPABASE_URL"]
    SUPABASE_SERVICE_ROLE_KEY = $envMap["SUPABASE_SERVICE_ROLE_KEY"]
    JWT_SECRET = $envMap["JWT_SECRET"]
    CORS_ORIGIN = if ($envMap.ContainsKey("CORS_ORIGIN")) { $envMap["CORS_ORIGIN"] } else { "*" }
  }
} | ConvertTo-Json -Depth 4

Set-Content -LiteralPath $EnvJsonPath -Value $envPayload -Encoding ascii

$functionExists = Test-AwsResource @(
  "lambda", "get-function",
  "--function-name", $FunctionName,
  "--region", $Region
)

if ($functionExists) {
  Write-Host "Actualizando Lambda $FunctionName..."
  Invoke-Aws @(
    "lambda", "update-function-code",
    "--function-name", $FunctionName,
    "--zip-file", "fileb://$ZipPath",
    "--region", $Region
  ) | Out-Null

  Invoke-Aws @(
    "lambda", "wait", "function-updated",
    "--function-name", $FunctionName,
    "--region", $Region
  ) | Out-Null

  Invoke-Aws @(
    "lambda", "update-function-configuration",
    "--function-name", $FunctionName,
    "--runtime", "nodejs20.x",
    "--handler", "lambda.handler",
    "--environment", "file://$EnvJsonPath",
    "--timeout", "15",
    "--memory-size", "256",
    "--region", $Region
  ) | Out-Null
} else {
  Write-Host "Creando Lambda $FunctionName..."
  Invoke-Aws @(
    "lambda", "create-function",
    "--function-name", $FunctionName,
    "--runtime", "nodejs20.x",
    "--handler", "lambda.handler",
    "--role", $roleArn,
    "--zip-file", "fileb://$ZipPath",
    "--environment", "file://$EnvJsonPath",
    "--timeout", "15",
    "--memory-size", "256",
    "--region", $Region
  ) | Out-Null
}

Remove-Item -LiteralPath $EnvJsonPath -Force -ErrorAction SilentlyContinue

$fn = Invoke-AwsJson @(
  "lambda", "get-function",
  "--function-name", $FunctionName,
  "--region", $Region
)

Write-Host ""
Write-Host "Lambda lista:"
Write-Host $fn.Configuration.FunctionArn
