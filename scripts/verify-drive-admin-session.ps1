$ErrorActionPreference = 'Stop'

$backendOrigin = 'https://siconstableexam.onrender.com'
$frontendOrigin = 'https://siconstableexam-1.onrender.com'
$expectedRedirectUri = "$frontendOrigin/api/drive/oauth2callback"
$secureKey = Read-Host 'Enter the rotated Drive administrator key (hidden prompt)' -AsSecureString
$keyPointer = [IntPtr]::Zero
$keyText = $null
$requestBody = $null
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$adminSessionHttp = 0
$adminSessionAccepted = $false
$sessionCookiePresent = $false
$oauthRequestHttp = 0
$authUrlReturned = $false
$redirectMatchesExpected = $false

try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $keyText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    $requestBody = @{ key = $keyText } | ConvertTo-Json -Compress

    try {
        $loginResponse = Invoke-WebRequest -Uri "$backendOrigin/api/drive/admin/session" -Method Post -WebSession $session -Headers @{ Origin = $frontendOrigin } -ContentType 'application/json' -Body $requestBody -TimeoutSec 45 -UseBasicParsing
        $adminSessionHttp = [int]$loginResponse.StatusCode
        $loginData = $loginResponse.Content | ConvertFrom-Json
        $adminSessionAccepted = [bool]$loginData.success
    } catch {
        if ($_.Exception.Response) {
            $adminSessionHttp = [int]$_.Exception.Response.StatusCode
        }
    }

    $cookieUri = [Uri]"$backendOrigin/api/drive/auth"
    $sessionCookiePresent = @($session.Cookies.GetCookies($cookieUri) | ForEach-Object { $_.Name }) -contains 'drive_admin_session'

    if ($adminSessionAccepted) {
        try {
            $authResponse = Invoke-WebRequest -Uri "$backendOrigin/api/drive/auth" -Method Get -WebSession $session -Headers @{ Origin = $frontendOrigin } -TimeoutSec 45 -UseBasicParsing
            $oauthRequestHttp = [int]$authResponse.StatusCode
            $authData = $authResponse.Content | ConvertFrom-Json
            $authUrlReturned = [bool]$authData.authUrl
            if ($authUrlReturned) {
                Add-Type -AssemblyName System.Web
                $authUri = [Uri]$authData.authUrl
                $authQuery = [System.Web.HttpUtility]::ParseQueryString($authUri.Query)
                $redirectMatchesExpected = $authQuery.Get('redirect_uri') -eq $expectedRedirectUri
            }
        } catch {
            if ($_.Exception.Response) {
                $oauthRequestHttp = [int]$_.Exception.Response.StatusCode
            }
        }
    }
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    if ($secureKey) {
        $secureKey.Dispose()
    }
    $keyText = $null
    $requestBody = $null
}

[pscustomobject]@{
    AdminSessionHttp = $adminSessionHttp
    AdminSessionAccepted = $adminSessionAccepted
    SessionCookiePresent = $sessionCookiePresent
    OAuthRequestHttp = $oauthRequestHttp
    AuthUrlReturned = $authUrlReturned
    RedirectMatchesExpected = $redirectMatchesExpected
} | Format-List
