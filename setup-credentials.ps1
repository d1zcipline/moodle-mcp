# Stores the Moodle site URL, login and password as an encrypted vault - never in plaintext.
# The prompts (site, login, password without echo) live in cli.mjs.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node cli.mjs vault init @args
exit $LASTEXITCODE
