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
#   enrollment  = Enrollment System group
#   finance     = Finance / Transaction group
#   lms         = LMS group
#   web-portal  = Web Portal group
#
# REGISTRATION COMMAND TEMPLATE (Claude fills in KEY, NAME, URL):
#   Invoke-RestMethod -Method Post `
#     -Uri "https://it-department-hub.onrender.com/hub/register" `
#     -Headers @{"x-api-key"="Kx9pQ2mZrT7vL4wN8sB3eJ6yC1hF5dA0"} `
#     -ContentType "application/json" `
#     -Body '{"key":"SYSTEM-KEY","name":"SYSTEM-NAME","base_url":"THEIR-URL"}'
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
Write-Host "Testing your URL..." -ForegroundColor Cyan

try {
    $test = Invoke-RestMethod "$url/api/db-check" -TimeoutSec 60
    Write-Host "Your system is online!" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Could not reach $url/api/db-check" -ForegroundColor Red
    Write-Host "Make sure your system is deployed and running." -ForegroundColor Red
    exit
}

Write-Host ""
Write-Host "Detecting your system..." -ForegroundColor Cyan

$key = ""
$name = ""

if ($url -like "*enrollment*") { $key = "enrollment"; $name = "Enrollment System" }
elseif ($url -like "*finance*") { $key = "finance"; $name = "Finance / Transaction" }
elseif ($url -like "*lms*") { $key = "lms"; $name = "LMS" }
elseif ($url -like "*portal*") { $key = "web-portal"; $name = "Web Portal" }
else {
    Write-Host ""
    Write-Host "Could not auto-detect your system. Pick your group:" -ForegroundColor Yellow
    Write-Host "1. Enrollment System"
    Write-Host "2. Finance / Transaction"
    Write-Host "3. LMS"
    Write-Host "4. Web Portal"
    $pick = Read-Host "Enter number (1-4)"
    switch ($pick) {
        "1" { $key = "enrollment"; $name = "Enrollment System" }
        "2" { $key = "finance"; $name = "Finance / Transaction" }
        "3" { $key = "lms"; $name = "LMS" }
        "4" { $key = "web-portal"; $name = "Web Portal" }
        default { Write-Host "Invalid choice." -ForegroundColor Red; exit }
    }
}

Write-Host "Detected: $name" -ForegroundColor Green
Write-Host "Registering with the IT Department Hub..." -ForegroundColor Cyan

try {
    $body = @{ key = $key; name = $name; base_url = $url } | ConvertTo-Json
    $result = Invoke-RestMethod `
        -Method Post `
        -Uri "https://it-department-hub.onrender.com/hub/register" `
        -Headers @{"x-api-key"="Kx9pQ2mZrT7vL4wN8sB3eJ6yC1hF5dA0"} `
        -ContentType "application/json" `
        -Body $body
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