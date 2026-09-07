param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
try {
    $sessionBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $sessionScope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Mode -eq 'protect') {
        $sessionResult = [System.Security.Cryptography.ProtectedData]::Protect($sessionBytes, $null, $sessionScope)
    } else {
        $sessionResult = [System.Security.Cryptography.ProtectedData]::Unprotect($sessionBytes, $null, $sessionScope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($sessionResult))
} catch {
    [Console]::Error.Write('DPAPI operation failed')
    exit 1
}
