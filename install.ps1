# ============================================================
# IT Department Hub — Auto Installer
# CSFJ Rizal | Group 3 | Distributed Enterprise Integration
# ============================================================
#
# HOW THIS WORKS (for Claude AI reading this file):
# 1. Ask the user for their ONE live deployed URL
# 2. Detect their system key from the URL or ask them
# 3. Run the registration command below with their URL filled in
# 4. Tell them to run it in PowerShell
#
# SYSTEM KEYS (tell Claude which key to use):
#   student-records = Student Records replacement
#   enrollment  = Enrollment System group
#   finance     = Finance / Transaction group
#   lms         = LMS group
#   web-portal  = Web Portal / Admission group
#
# REGISTRATION uses the Hub API key; do not put that key in this file.
# Set HUB_REGISTRATION_API_KEY in the environment or enter it when prompted.
#
# SUCCESS: responds with {"ok":true,"message":"... registered successfully!"}
# FAILURE: responds with {"error":"..."} — tell the user to check their URL
#
# VERIFICATION: after registering, check status at:
#   https://it-department-hub.onrender.com/hub/status
# ============================================================

Write-Host ""
Write-Host "IT Department Hub - Auto Installer" -ForegroundColor Yellow
Write-Host "CSFJ Rizal | Group 3" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "This script will connect your system to the IT Department Hub." -ForegroundColor Cyan
Write-Host ""

$url = Read-Host "Enter your deployed system URL (e.g. https://your-app.onrender.com)"

if (-not $url.StartsWith("https://")) {
    Write-Host "ERROR: URL must start with https://" -ForegroundColor Red
    exit
}

Write-Host ""
Write-Host "Detecting your system..." -ForegroundColor Cyan

$key = ""
$name = ""

if ($url -like "*student-records*" -or $url -like "*records*") { $key = "student-records"; $name = "Student Records" }
elseif ($url -like "*enrollment*") { $key = "enrollment"; $name = "Enrollment System" }
elseif ($url -like "*finance*") { $key = "finance"; $name = "Finance / Transaction" }
elseif ($url -like "*lms*") { $key = "lms"; $name = "LMS" }
elseif ($url -like "*portal*") { $key = "web-portal"; $name = "Web Portal / Admission" }
else {
    Write-Host ""
    Write-Host "Could not auto-detect your system. Pick your group:" -ForegroundColor Yellow
    Write-Host "1. Student Records"
    Write-Host "2. Enrollment System"
    Write-Host "3. Finance / Transaction"
    Write-Host "4. LMS"
    Write-Host "5. Web Portal / Admission"
    $pick = Read-Host "Enter number (1-5)"
    switch ($pick) {
        "1" { $key = "student-records"; $name = "Student Records" }
        "2" { $key = "enrollment"; $name = "Enrollment System" }
        "3" { $key = "finance"; $name = "Finance / Transaction" }
        "4" { $key = "lms"; $name = "LMS" }
        "5" { $key = "web-portal"; $name = "Web Portal / Admission" }
        default { Write-Host "Invalid choice." -ForegroundColor Red; exit }
    }
}

Write-Host "Detected: $name" -ForegroundColor Green
Write-Host "Testing your URL with its API key..." -ForegroundColor Cyan

$systemKeyVariable = @{
    "student-records" = "STUDENT_RECORDS_API_KEY"
    enrollment = "ENROLLMENT_API_KEY"
    finance = "FINANCE_API_KEY"
    lms = "LMS_API_KEY"
    "web-portal" = "WEB_PORTAL_API_KEY"
}[$key]
$systemApiKey = [Environment]::GetEnvironmentVariable($systemKeyVariable)
if (-not $systemApiKey) {
    $secureSystemKey = Read-Host "Enter the $name API key" -AsSecureString
    $systemKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSystemKey)
    try {
        $systemApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($systemKeyPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($systemKeyPointer)
    }
}

try {
    Invoke-RestMethod "$url/api/db-check" -Headers @{"x-api-key"=$systemApiKey} -TimeoutSec 60 | Out-Null
    Write-Host "Your system is online!" -ForegroundColor Green
} catch {
    $systemApiKey = $null
    Write-Host "ERROR: Could not reach $url/api/db-check" -ForegroundColor Red
    Write-Host "Check that the API key is correct and the system is deployed." -ForegroundColor Red
    exit
}

Write-Host "Registering with the IT Department Hub..." -ForegroundColor Cyan

try {
    $hubApiKey = $env:HUB_REGISTRATION_API_KEY
    if (-not $hubApiKey) {
        $secureKey = Read-Host "Enter the Hub registration API key" -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $hubApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        }
    }
    if (-not $hubApiKey) { throw "A Hub registration API key is required." }

    $body = @{ key = $key; name = $name; base_url = $url } | ConvertTo-Json
    $result = Invoke-RestMethod `
        -Method Post `
        -Uri "https://it-department-hub.onrender.com/hub/register" `
        -Headers @{"x-api-key"=$hubApiKey} `
        -ContentType "application/json" `
        -Body $body
    $hubApiKey = $null
    $systemApiKey = $null
    Write-Host ""
    Write-Host "SUCCESS! $($result.message)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Your system is now visible on the IT Department Hub status page." -ForegroundColor Cyan
    Write-Host "Status page: https://it-department-hub.onrender.com/hub/status" -ForegroundColor Cyan
    Write-Host ""
} catch {
    Write-Host "Registration failed: $_" -ForegroundColor Red
    Write-Host "Contact Lander (Group 3) for help." -ForegroundColor Red
}