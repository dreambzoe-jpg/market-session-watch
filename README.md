# Market Session Watch

A mobile trading companion for forex traders that tracks global market sessions in real time, delivers economic event calendars, and provides AI-driven XAUUSD (Gold) fundamental analysis — all from a single Android app.

Built with React 19 + Capacitor 7 (Android native), Express.js backend, and deployed on Railway.

---

## Features

### 1. Market Session Alerts
- Tracks 8 forex sessions: Pre-Asian, Asian Open, Pre-London, London Open, London Close, Pre-NY, NY Open, NYSE
- Animated countdown ring with second-by-second progress
- Live/upcoming session cards with colored progress bars
- Native Android alarms using `AlarmManager.setAlarmClock()` — survives Doze mode
- Full-screen alarm notifications that wake the screen on lock
- Custom ringtone picker for session start and reminder tones
- Auto-reschedules for the next day after firing
- Survives device reboots (BootReceiver restores alarms)

### 2. 15-Minute Interval Reminders
- Fires every 15 minutes during active sessions
- Displays current interval (e.g. "Interval 3/8 — 45 min remaining")
- Three modes: Off, Once (fire once then disable), Continuous
- Separate customizable ringtone (Ringtone A)

### 3. Economic Calendar
- Embedded TradingView Economic Calendar widget
- Filtered to high-impact events (US, GB, EU, JP, CA, AU)
- Dark theme synced with the app

### 4. XAUUSD Fundamental Bias
- Receives daily gold analysis emails from Grok AI (x.ai)
- Server parses email body for sentiment: Bullish, Bearish, or Neutral
- Extracts structured summary with key drivers
- Two data paths:
  - **Zapier webhook** (primary): email arrives → Zapier POSTs parsed data to server
  - **Direct Gmail API** (fallback): server fetches email via OAuth2
- Manual refresh button triggers Zapier Catch Hook for on-demand fetch
- Client-side caching in localStorage

### 5. Vibrate Mode Sync
- Auto-detects phone ringer mode (Normal / Vibrate / Silent)
- When in vibrate mode: suppresses alarm sounds, vibrates instead
- Real-time detection via `AudioManager.RINGER_MODE_VIBRATE`
- Listens for `RINGER_MODE_CHANGED` broadcasts

---

## Architecture

```
┌─────────────────────────────────┐
│  Android App (Capacitor WebView)│
│  React 19 + Tailwind + Motion   │
│  ↕ Capacitor Plugin Bridge      │
│  Native Java (Alarms, Vibrate)  │
└──────────────┬──────────────────┘
               │ HTTPS
┌──────────────▼──────────────────┐
│  Express.js Server (Railway)    │
│  /api/fundamentals (GET)        │
│  /api/fundamentals/trigger (POST)│
│  /api/zapier/hook (POST)        │
│  Gmail OAuth2 (fallback)        │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│  Zapier Zap                     │
│  Gmail trigger → Webhook POST   │
└─────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 6, Tailwind CSS 4, Motion (Framer) |
| Native | Capacitor 7, Android SDK (Java) |
| Backend | Express.js, tsx (TypeScript runner) |
| APIs | Gmail API (OAuth2), Zapier Webhooks, TradingView Widgets |
| Hosting | Railway (Docker) |
| Notifications | Android AlarmManager, NotificationManager, MediaPlayer |

---

## Setup

### Prerequisites
- Node.js 20+
- Android Studio (for building the APK)
- Google Cloud project with Gmail API enabled
- Zapier account (for webhook integration)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Fill in:
- `VITE_GOOGLE_CLIENT_ID` — Google OAuth client ID
- `GMAIL_CLIENT_SECRET` — Google OAuth client secret
- `VITE_API_URL` — Your Railway public URL (or `http://localhost:3001` for local dev)

### 3. Get Gmail refresh token
```bash
npm run server
# Open http://localhost:3001/auth/setup in your browser
# Follow Google login, copy the refresh token into .env
```

### 4. Run locally
```bash
# Terminal 1: Backend
npm run server

# Terminal 2: Frontend (proxies /api to :3001)
npm run dev
```

### 5. Build for Android
```bash
npm run cap:build
# Open in Android Studio:
npx cap open android
```

---

## Deployment (Railway)

The server is deployed via Docker on Railway.

```bash
# railway.json configures the DOCKERFILE builder
# Dockerfile: node:20-alpine → npm ci → server.ts
```

**Required Railway environment variables:**
| Variable | Description |
|----------|-------------|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail refresh token (from /auth/setup) |
| `ZAPIER_WEBHOOK_SECRET` | Secret for Zapier webhook auth (optional) |
| `ZAPIER_CATCH_HOOK_URL` | Zapier Catch Hook URL for manual triggers |

Railway auto-injects `PORT`.

---

## Project Structure

```
├── src/
│   ├── App.tsx              # Main React app (sessions, alerts, UI)
│   ├── gmailService.ts      # Client-side cache helpers
│   ├── index.css            # Tailwind theme, animations, dark mode
│   └── main.tsx             # React entry point
├── server.ts                # Express backend (Gmail, Zapier, OAuth)
├── android/
│   └── app/src/main/
│       ├── AndroidManifest.xml
│       └── java/com/bzoe/marketsessionwatch/
│           ├── SessionAlarmPlugin.java      # Capacitor bridge
│           ├── SessionAlarmScheduler.java   # Alarm scheduling
│           ├── SessionAlarmReceiver.java    # Session start handler
│           ├── CountdownReminderReceiver.java # 15-min reminders
│           ├── RingerModeReceiver.java      # Vibrate mode detection
│           ├── BootReceiver.java            # Restore alarms on reboot
│           ├── SessionAlarmDismissReceiver.java
│           ├── CountdownReminderDismissReceiver.java
│           ├── MarketWidgetProvider.java    # Home screen widget
│           └── MainActivity.java
├── Dockerfile               # Railway deployment
├── railway.json             # Railway config (DOCKERFILE builder)
├── capacitor.config.ts      # Capacitor settings
├── vite.config.ts           # Vite + Tailwind + proxy config
├── package.json
└── .env.example
```

---

## Android Permissions

| Permission | Purpose |
|-----------|---------|
| `POST_NOTIFICATIONS` | Show alarm and reminder notifications |
| `VIBRATE` | Vibration feedback |
| `SCHEDULE_EXACT_ALARM` | Precise session start alarms |
| `USE_FULL_SCREEN_INTENT` | Lock-screen alarm popup |
| `WAKE_LOCK` | Wake screen when alarm fires |
| `RECEIVE_BOOT_COMPLETED` | Restore alarms after reboot |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Prevent Doze from killing alarms |
| `INTERNET` | API calls to backend |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (port 3000) |
| `npm run build:client` | Production build → dist/ |
| `npm run server` | Start Express backend |
| `npm run cap:build` | Build client + sync to Android |
| `npm run cap:sync` | Sync web assets to Android |
| `npm run cap:open` | Open Android Studio |

---

## License

Proprietary — BZOE Creativies. All rights reserved.
