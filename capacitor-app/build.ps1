# Builds the Corpvex Authenticator debug APK (Capacitor 8, SDK 36). ASCII-only.
# Paths are derived from this script's location, so the repo can live anywhere.
$ErrorActionPreference = 'Continue'
$env:ANDROID_HOME     = 'D:\android-sdk'
$env:ANDROID_SDK_ROOT = 'D:\android-sdk'
$cap  = $PSScriptRoot
$root = Split-Path $cap -Parent
Set-Location $cap

Write-Host "================ [1/6] npm install ================"
npm install --no-audit --no-fund

Write-Host "================ [2/6] sync web assets -> www ================"
$www = Join-Path $cap 'www'
if (-not (Test-Path $www)) { New-Item -ItemType Directory $www | Out-Null }
$assets = @('index.html','app.js','styles.css','manifest.webmanifest','sw.js',
            'firebase-config.js','firebase-messaging-sw.js',
            'icon-192.png','icon-512.png','icon-maskable-512.png')
foreach ($a in $assets) {
  $p = Join-Path $root $a
  if (Test-Path $p) { Copy-Item $p $www -Force }
}

Write-Host "================ [3/6] cap add android ================"
if (-not (Test-Path (Join-Path $cap 'android'))) {
  npx cap add android
} else {
  Write-Host "android/ already exists - skipping add"
}

Write-Host "================ [4/6] configure (SDK 36 + sdk.dir) ================"
$vg = Join-Path $cap 'android\variables.gradle'
if (Test-Path $vg) {
  $c = Get-Content $vg -Raw
  $c = $c -replace 'compileSdkVersion = \d+', 'compileSdkVersion = 36'
  $c = $c -replace 'targetSdkVersion = \d+',  'targetSdkVersion = 36'
  Set-Content $vg $c -Encoding ascii
}
Set-Content (Join-Path $cap 'android\local.properties') 'sdk.dir=D:\\android-sdk' -Encoding ascii

Write-Host "================ [5/6] cap sync ================"
npx cap sync android

Write-Host "================ [6/6] gradle assembleDebug ================"
Set-Location (Join-Path $cap 'android')
.\gradlew.bat assembleDebug --no-daemon

$apk = Join-Path $cap 'android\app\build\outputs\apk\debug\app-debug.apk'
$out = Join-Path $root 'Corpvex.apk'
if (Test-Path $apk) {
  Copy-Item $apk $out -Force
  $mb = [math]::Round((Get-Item $apk).Length/1MB, 2)
  Write-Host ("BUILD OK -> " + $out + "  " + $mb + " MB")
} else {
  Write-Host "BUILD FAILED - app-debug.apk not produced"
}
