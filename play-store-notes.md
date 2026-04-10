# Google Play Store Submission Notes

## Data Safety Form Answers

Fill these in the Play Console under **App content → Data safety**:

### Does your app collect or share any of the required user data types?
**Yes**

### Data collected:

| Data type | Collected | Shared | Purpose | Optional |
|-----------|-----------|--------|---------|----------|
| Email messages | Yes (read-only, specific emails only) | No | App functionality — fetches XAUUSD analysis emails | No |
| App interactions | No | No | — | — |
| Device or other IDs | No | No | — | — |
| Location | No | No | — | — |
| Personal info | No | No | — | — |
| Financial info | No | No | — | — |
| Photos/Videos | No | No | — | — |
| Contacts | No | No | — | — |

### Is all collected data encrypted in transit?
**Yes** — all API calls use HTTPS.

### Do you provide a way for users to request data deletion?
**Yes** — users can clear app data via Android settings, which removes all cached data. No server-side personal data is retained.

### Data retention:
Email analysis data is cached **transiently in server memory** (cleared on restart) and in **device localStorage** (cleared when app data is cleared). No persistent database stores user data.

---

## Permission Justifications (for Review Notes)

Paste this into Play Console under **App content → Permissions declaration** or in the review notes:

### REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
> Market Session Watch is an alarm-based trading tool that fires time-critical notifications at exact forex market session open times (e.g., London Open at 08:00 UTC). These alarms must fire precisely, even during Doze mode. The app qualifies under Google's exemption for "alarm clock" functionality. Battery optimization exemption is requested via a system dialog initiated by the user — it is never applied silently.

### USE_FULL_SCREEN_INTENT / SCHEDULE_EXACT_ALARM
> The app functions as a market session alarm clock. When a forex session opens, the app wakes the device screen and displays a full-screen notification (similar to a phone alarm). This requires exact alarm scheduling and full-screen intent permissions. The user explicitly enables this feature and can disable it at any time.

### WAKE_LOCK
> Used solely to wake the device screen for 30 seconds when a market session alarm fires, ensuring the trader sees the notification even if the device is asleep.

### POST_NOTIFICATIONS
> Required on Android 13+ to display session start alarms, 15-minute interval reminders, and dismiss actions. The app requests this permission during an onboarding wizard — it is never requested without user context.

### RECEIVE_BOOT_COMPLETED
> Restores previously-enabled session alarms after a device reboot so traders don't miss market openings. No background services are started — only AlarmManager pending intents are re-registered.

---

## Gmail API Restricted Scope Justification

If Google requires justification for `gmail.readonly`:

> Market Session Watch uses the Gmail API (gmail.readonly scope) to fetch a single, specific type of automated email: daily XAUUSD gold fundamental analysis sent by noreply@x.ai. The app searches for emails matching "from:noreply@x.ai subject:(XAUUSD OR Gold OR Fundamentals)" and reads only the most recent match. No other emails are accessed, stored, or transmitted. The Gmail credentials (client secret, refresh token) are stored exclusively on the server — never in the client app bundle. The app complies with Google's Limited Use Requirements: data is used only to provide the app's core XAUUSD analysis feature and is not shared with third parties.

---

## Release Signing Instructions

### Generate a release keystore (run once, keep the .jks file safe):

```bash
keytool -genkeypair -v -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -storepass YOUR_STORE_PASSWORD -keypass YOUR_KEY_PASSWORD -alias market-session-watch -keystore release-key.jks -dname "CN=BZOE Creativies, O=BZOE Creativies, L=Your City, ST=Your State, C=Your Country"
```

**IMPORTANT:** Back up `release-key.jks` and your passwords. If you lose them, you can never update your app on Google Play.

### Add to `.gitignore`:
```
release-key.jks
```

### Configure signing in Android Studio:
1. Open `android/` in Android Studio
2. Build → Generate Signed Bundle / APK
3. Choose **Android App Bundle (AAB)** — Google Play requires AAB, not APK
4. Select your `release-key.jks`, enter passwords
5. Choose **release** build variant
6. Build — output will be at `android/app/release/app-release.aab`

### Or configure via Gradle (android/app/build.gradle):
```gradle
android {
    signingConfigs {
        release {
            storeFile file('../../release-key.jks')
            storePassword 'YOUR_STORE_PASSWORD'
            keyAlias 'market-session-watch'
            keyPassword 'YOUR_KEY_PASSWORD'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

---

## Store Listing Assets Checklist

| Asset | Spec | Status |
|-------|------|--------|
| App icon | 512x512 PNG, 32-bit, no transparency | Needed |
| Feature graphic | 1024x500 PNG or JPG | Needed |
| Phone screenshots | Min 2, 16:9 or 9:16, min 320px, max 3840px | Needed |
| Tablet screenshots | Optional but recommended, 7" and 10" | Optional |
| Short description | Max 80 chars | Done (see store-listing.md) |
| Full description | Max 4000 chars | Done (see store-listing.md) |
| Privacy policy URL | Required | Done (host privacy-policy.html) |
| Category | Finance | — |
| Content rating | Complete IARC questionnaire | See store-listing.md |
| Target audience | 18+ (financial tool) | — |

---

## TradingView Widget Usage

TradingView's free widgets are permitted for use in websites and apps under their Terms of Service, provided:
- The TradingView branding/attribution remains visible (the widget includes this by default)
- You do not modify or remove TradingView branding
- The widget is loaded from TradingView's CDN (not self-hosted)

Your implementation loads from `s3.tradingview.com` with default branding — this is compliant.

---

## Hosting the Privacy Policy

Options (cheapest to easiest):
1. **GitHub Pages**: Push `privacy-policy.html` to a GitHub repo, enable Pages → URL: `https://dreambzoe-jpg.github.io/market-session-watch/privacy-policy.html`
2. **Railway**: Add a static route on your existing server to serve the file
3. **Any web host**: Upload the HTML file anywhere publicly accessible

Recommendation: Use GitHub Pages — it's free and permanent.
