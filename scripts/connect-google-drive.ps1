$ErrorActionPreference = 'Stop'

$backendUrl = 'https://siconstableexam.onrender.com'
$frontendOrigin = 'https://siconstableexam-1.onrender.com'
$expectedRedirectUri = "$frontendOrigin/api/drive/oauth2callback"
$secureAdminKey = Read-Host 'Enter the rotated Drive administrator key' -AsSecureString
$keyPointer = [IntPtr]::Zero
$adminKey = $null
$requestBody = $null

try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAdminKey)
    $adminKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    $requestBody = @{ key = $adminKey } | ConvertTo-Json -Compress
    $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession

    $login = Invoke-RestMethod -Uri "$backendUrl/api/drive/admin/session" -Method Post -WebSession $webSession -Headers @{ Origin = $frontendOrigin } -ContentType 'application/json' -Body $requestBody
    if (-not $login.success) {
        throw 'Drive administrator authorization was rejected.'
    }

    $authorization = Invoke-RestMethod -Uri "$backendUrl/api/drive/auth" -Method Get -WebSession $webSession -Headers @{ Origin = $frontendOrigin }
    $authorizationUri = [Uri]$authorization.authUrl
    if ($authorizationUri.Scheme -ne 'https' -or $authorizationUri.Host -ne 'accounts.google.com') {
        throw 'The server returned an unexpected Google authorization URL.'
    }

    Add-Type -AssemblyName System.Web
    $query = [System.Web.HttpUtility]::ParseQueryString($authorizationUri.Query)
    if ($query.Get('redirect_uri') -ne $expectedRedirectUri) {
        throw 'The server authorization URL does not use the expected production callback.'
    }

    Start-Process -FilePath $authorizationUri.AbsoluteUri
    Write-Host 'Complete Google authorization using the existing Drive owner account.'
    [void](Read-Host 'After Google returns to the app, press Enter to verify Drive access')

    $status = Invoke-RestMethod -Uri "$backendUrl/api/drive/auth/status" -Method Get -TimeoutSec 45
    $rootMatches = $status.rootFolderId -eq '1rz_XI2AkAkQNfrsbKW9Rs78xSptWFJ1z'
    if ($status.connected -and $status.rootFolderAccessible -and $rootMatches) {
        Write-Host 'Drive connected; the existing Notes Library root is accessible.'
        exit 0
    }

    $safeCode = if ($status.code) { $status.code } else { 'DRIVE_NOT_READY' }
    Write-Error "Drive access is not verified. connected=$($status.connected); rootAccessible=$($status.rootFolderAccessible); rootMatches=$rootMatches; code=$safeCode"
    exit 1
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    Write-Error "Drive owner authorization failed. HTTP status: $statusCode. No credential values were written to output."
    exit 1
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    if ($secureAdminKey) {
        $secureAdminKey.Dispose()
    }
    $adminKey = $null
    $requestBody = $null
}