import React, { useState, useEffect, useRef, memo, useMemo } from 'react';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import {
  Bell, BellOff, Timer, Repeat, RotateCcw, X, Zap, Activity,
  BatteryCharging, AlarmClock, Music, CheckCircle2, ChevronDown, ChevronUp,
  AlertCircle, TrendingUp, TrendingDown, Minus, Clock, LayoutGrid, Volume2, Play,
  ToggleLeft, ToggleRight, ChevronRight, RefreshCw, Mail, Vibrate, Search,
} from 'lucide-react';
import {
  getCachedFundamentals, storeCachedFundamentals,
  getLastKnownEmailId, setLastKnownEmailId,
} from './gmailService';
import type { FundamentalsData } from './gmailService';
import { motion, AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { App as CapApp } from '@capacitor/app';

// ─── Native alarm plugin ───────────────────────────────────────────
interface SessionAlarmPlugin {
  enable(): Promise<{ enabled: boolean }>;
  disable(): Promise<{ enabled: boolean }>;
  isEnabled(): Promise<{ enabled: boolean }>;
  dismiss(): Promise<{ dismissed: boolean }>;
  setReminderMode(opts: { mode: string }): Promise<{ mode: string }>;
  getReminderMode(): Promise<{ mode: string }>;
  testAlarm(opts: { delaySec: number }): Promise<{ scheduled: boolean; firesInSec: number }>;
  requestIgnoreBatteryOptimization(): Promise<{ alreadyIgnoring?: boolean; requested?: boolean }>;
  getBatteryOptimizationStatus(): Promise<{ isIgnoringBatteryOptimization: boolean }>;
  getExactAlarmStatus(): Promise<{ canScheduleExactAlarms: boolean }>;
  openExactAlarmSettings(): Promise<{ opened: boolean }>;
  pickSessionRingtone(): Promise<{ uri: string | null; name: string }>;
  getSelectedSessionRingtone(): Promise<{ uri: string | null; name: string }>;
  pickReminderRingtone(): Promise<{ uri: string | null; name: string }>;
  getSelectedReminderRingtone(): Promise<{ uri: string | null; name: string }>;
  getRingerMode(): Promise<{ mode: string }>;
}
const SessionAlarm = registerPlugin<SessionAlarmPlugin>('SessionAlarm');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const API_BASE: string = ((import.meta as any).env?.VITE_API_URL ?? '');

const TIMEZONE = 'UTC';

const GROUP_CONFIG = {
  Asian:      { color: '#8B5CF6', letter: 'AS', flag: 'TOKYO'    },
  London:     { color: '#10B981', letter: 'LN', flag: 'LONDON'   },
  'New York': { color: '#3B82F6', letter: 'NY', flag: 'NEW YORK' },
} as const;

interface Session {
  id: string;
  group: 'Asian' | 'London' | 'New York';
  label: string;
  start: string;
  end: string;
  isPeak?: boolean;
  color?: string;
}

const SESSIONS: Session[] = [
  { id: 'pre-asian',    group: 'Asian',    label: 'Pre - Asian',   start: '23:00', end: '01:00' },
  { id: 'asian-open',   group: 'Asian',    label: 'Asian Open',    start: '01:00', end: '03:00', isPeak: true, color: '#8B5CF6' },
  { id: 'pre-london',   group: 'London',   label: 'Pre - London',  start: '06:00', end: '08:00' },
  { id: 'london-open',  group: 'London',   label: 'London Open',   start: '08:00', end: '09:30', isPeak: true, color: '#10B981' },
  { id: 'london-close', group: 'London',   label: 'London Close',  start: '15:00', end: '16:00' },
  { id: 'pre-ny',       group: 'New York', label: 'Pre NY',        start: '11:00', end: '13:00' },
  { id: 'ny-open',      group: 'New York', label: 'NY Open',       start: '13:00', end: '14:30', isPeak: true, color: '#3B82F6' },
  { id: 'nyse',         group: 'New York', label: 'NYSE',          start: '14:30', end: '15:00', isPeak: true, color: '#F27D26' },
];

// Web ringtone presets
const WEB_RINGTONES = [
  { id: 'chime',  name: 'Market Chime',  url: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3' },
  { id: 'bell',   name: 'Trading Bell',  url: 'https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3' },
  { id: 'alert',  name: 'Sharp Alert',   url: 'https://assets.mixkit.co/active_storage/sfx/2868/2868-preview.mp3' },
  { id: 'subtle', name: 'Subtle Ping',   url: 'https://assets.mixkit.co/active_storage/sfx/2570/2570-preview.mp3' },
];

// ─── Helpers ───────────────────────────────────────────────────────
function isSessionActive(session: Session, nowInNY: Date): boolean {
  const [sH, sM] = session.start.split(':').map(Number);
  const [eH, eM] = session.end.split(':').map(Number);
  const cur = nowInNY.getHours() * 60 + nowInNY.getMinutes();
  const st  = sH * 60 + sM;
  const et  = eH * 60 + eM;
  return st < et ? cur >= st && cur < et : cur >= st || cur < et;
}

function getSessionDuration(start: string, end: string): string {
  const [sH, sM] = start.split(':').map(Number);
  const [eH, eM] = end.split(':').map(Number);
  let diff = (eH * 60 + eM) - (sH * 60 + sM);
  if (diff < 0) diff += 1440;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

function getSessionProgress(start: string, end: string, now: Date): number {
  const [sH, sM] = start.split(':').map(Number);
  const [eH, eM] = end.split(':').map(Number);
  let total = (eH * 60 + eM) - (sH * 60 + sM);
  if (total < 0) total += 1440;
  const cur = now.getHours() * 60 + now.getMinutes();
  let elapsed = cur - (sH * 60 + sM);
  if (elapsed < 0) elapsed += 1440;
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

function getCountdown(targetTimeStr: string, nowInNY: Date): string {
  const [tH, tM] = targetTimeStr.split(':').map(Number);
  const cur = nowInNY.getHours() * 3600 + nowInNY.getMinutes() * 60 + nowInNY.getSeconds();
  let diff = (tH * 3600 + tM * 60) - cur;
  if (diff < 0) diff += 86400;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return [h, m, s].map(n => n.toString().padStart(2, '0')).join(':');
}

// SVG Ring
const RING_R        = 108;
const RING_SIZE     = 240;
const RING_CX       = RING_SIZE / 2;
const RING_CY       = RING_SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RING_R;

// ─── TradingView Economic Events Widget ────────────────────────────
// Always rendered in dark theme to match the app's default dark aesthetic.
const EconomicCalendar = memo(() => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || container.querySelector('script')) return;
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      colorTheme: 'dark',
      isTransparent: false,
      locale: 'en',
      countryFilter: 'us,gb,eu,jp,ca,au',
      importanceFilter: '0,1',
      width: '100%',
      height: '420',
    });
    container.appendChild(script);
    return () => { try { container.removeChild(script); } catch {} };
  }, []);

  return (
    <div className="tradingview-widget-container w-full tv-dark-container" ref={containerRef}
      style={{ background: '#131722', borderRadius: '12px', overflow: 'hidden' }}>
      <div className="tradingview-widget-container__widget w-full" style={{ height: 420, background: '#131722' }} />
    </div>
  );
});

// ─── Feature Panel (slide-up sheet) ───────────────────────────────
type PanelSection = 'home' | 'alarms' | 'calendar' | 'fundamentals';

function FeaturePanel({
  open, onClose, isNative, isDark, alertsEnabled, setAlertsEnabled,
  notifGranted, reminderMode, setReminderMode,
  sessionRingtoneName, setSessionRingtoneName,
  reminderRingtoneName, setReminderRingtoneName,
  webSessionRingtoneId, setWebSessionRingtoneId,
  webReminderRingtoneId, setWebReminderRingtoneId,
  batteryOptOff, setBatteryOptOff, canExactAlarm, setCanExactAlarm,
  requestPermission, sendNotification, sendReminderNotification, playAlertSound, playReminderSound,
  fundamentals, fundamentalsLoading, fundamentalsError,
  onRefreshFundamentals, onTriggerMake, makeTriggered, ringerMode,
}: {
  open: boolean; onClose: () => void; isNative: boolean; isDark: boolean;
  alertsEnabled: boolean; setAlertsEnabled: (v: boolean) => void;
  notifGranted: boolean;
  ringerMode: string | null;
  reminderMode: 'off' | 'once' | 'continuous'; setReminderMode: (v: 'off' | 'once' | 'continuous') => void;
  sessionRingtoneName: string; setSessionRingtoneName: (v: string) => void;
  reminderRingtoneName: string; setReminderRingtoneName: (v: string) => void;
  webSessionRingtoneId: string; setWebSessionRingtoneId: (v: string) => void;
  webReminderRingtoneId: string; setWebReminderRingtoneId: (v: string) => void;
  batteryOptOff: boolean | null; setBatteryOptOff: (v: boolean) => void;
  canExactAlarm: boolean | null; setCanExactAlarm: (v: boolean) => void;
  requestPermission: () => Promise<'granted' | 'denied' | 'default'>;
  sendNotification: (t: string, b: string) => Promise<void>;
  sendReminderNotification: (title?: string, body?: string) => Promise<void>;
  playAlertSound: () => void;
  playReminderSound: () => void;
  fundamentals: FundamentalsData | null;
  fundamentalsLoading: boolean;
  fundamentalsError: string | null;
  onRefreshFundamentals: () => void;
  onTriggerMake: () => Promise<void>;
  makeTriggered: boolean;
}) {
  const [section, setSection] = useState<PanelSection>('home');
  const [expandedSound, setExpandedSound] = useState<'reminder' | 'session' | null>(null);

  // Reset to home when panel closes
  useEffect(() => { if (!open) { setTimeout(() => { setSection('home'); setExpandedSound(null); }, 300); } }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            key="sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
            className="fixed bottom-0 inset-x-0 z-[90] rounded-t-3xl bg-[var(--bg-panel)] border-t border-white/[0.07] overflow-hidden"
            style={{ maxHeight: '88vh' }}
          >
            {/* Handle bar */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-white/[0.12]" />
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: 'calc(88vh - 24px)' }}>
              <AnimatePresence mode="wait">

                {/* ── Home ── */}
                {section === 'home' && (
                  <motion.div key="home" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.2 }}
                    className="px-5 pt-2 pb-8">
                    <div className="flex items-center justify-between mb-5">
                      <div>
                        <h2 className="text-[15px] font-black tracking-tight">Features</h2>
                        <p className="text-[9px] text-white/25 mt-0.5 tracking-widest uppercase">Market Session Watch</p>
                      </div>
                      <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                        <X size={14} />
                      </button>
                    </div>

                    {/* Feature tiles */}
                    <div className="grid grid-cols-2 gap-3">
                      {/* Alarms */}
                      <button onClick={() => setSection('alarms')}
                        className="relative rounded-2xl bg-gradient-to-br from-[#3B82F6]/12 to-[#3B82F6]/04 border border-[#3B82F6]/20 p-4 text-left overflow-hidden group hover:border-[#3B82F6]/40 transition-all">
                        <div className="absolute top-0 right-0 w-16 h-16 rounded-full bg-[#3B82F6]/08 blur-xl" />
                        <div className="w-9 h-9 rounded-xl bg-[#3B82F6]/15 border border-[#3B82F6]/20 flex items-center justify-center mb-3">
                          <AlarmClock size={17} className="text-[#3B82F6]" />
                        </div>
                        <div className="text-[12px] font-black text-white/80 mb-0.5">Alarms</div>
                        <div className="text-[9px] text-white/30">Session alerts &amp; reminders</div>
                        <div className="flex items-center gap-1 mt-3">
                          <div className={`w-1.5 h-1.5 rounded-full ${alertsEnabled ? 'bg-emerald-400' : 'bg-white/20'}`} />
                          <span className={`text-[8px] font-bold uppercase tracking-wider ${alertsEnabled ? 'text-emerald-400' : 'text-white/20'}`}>
                            {alertsEnabled ? 'Active' : 'Off'}
                          </span>
                        </div>
                      </button>

                      {/* Economic Calendar */}
                      <button onClick={() => setSection('calendar')}
                        className="relative rounded-2xl bg-gradient-to-br from-[#F27D26]/12 to-[#F27D26]/04 border border-[#F27D26]/20 p-4 text-left overflow-hidden group hover:border-[#F27D26]/40 transition-all">
                        <div className="absolute top-0 right-0 w-16 h-16 rounded-full bg-[#F27D26]/08 blur-xl" />
                        <div className="w-9 h-9 rounded-xl bg-[#F27D26]/15 border border-[#F27D26]/20 flex items-center justify-center mb-3">
                          <Activity size={17} className="text-[#F27D26]" />
                        </div>
                        <div className="text-[12px] font-black text-white/80 mb-0.5">Events</div>
                        <div className="text-[9px] text-white/30">Forex economic calendar</div>
                        <div className="flex items-center gap-1 mt-3">
                          <div className="w-1.5 h-1.5 rounded-full bg-[#F27D26]/60" />
                          <span className="text-[8px] font-bold uppercase tracking-wider text-[#F27D26]/60">Live data</span>
                        </div>
                      </button>

                      {/* Gold Bias */}
                      <button onClick={() => setSection('fundamentals')}
                        className="relative rounded-2xl bg-gradient-to-br from-[#EAB308]/12 to-[#EAB308]/04 border border-[#EAB308]/20 p-4 text-left overflow-hidden group hover:border-[#EAB308]/40 transition-all col-span-2">
                        <div className="absolute top-0 right-0 w-24 h-16 rounded-full bg-[#EAB308]/08 blur-xl" />
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-[#EAB308]/15 border border-[#EAB308]/20 flex items-center justify-center shrink-0">
                            {fundamentals?.bias === 'bullish' ? <TrendingUp size={17} className="text-[#EAB308]" />
                              : fundamentals?.bias === 'bearish' ? <TrendingDown size={17} className="text-[#EAB308]" />
                              : <Minus size={17} className="text-[#EAB308]" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-black text-white/80 mb-0.5">XAUUSD Bias</div>
                            <div className="text-[9px] text-white/30">Gold fundamental analysis via Grok</div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {fundamentals ? (
                              <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-lg ${
                                fundamentals.bias === 'bullish' ? 'bg-emerald-500/20 text-emerald-400'
                                  : fundamentals.bias === 'bearish' ? 'bg-red-500/20 text-red-400'
                                  : 'bg-[#EAB308]/20 text-[#EAB308]'
                              }`}>{fundamentals.bias}</span>
                            ) : (
                              <span className="text-[8px] font-bold uppercase tracking-wider text-[#EAB308]/50">No data</span>
                            )}
                          </div>
                        </div>
                      </button>

                    </div>
                  </motion.div>
                )}

                {/* ── Alarms ── */}
                {section === 'alarms' && (
                  <motion.div key="alarms" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.2 }}
                    className="px-5 pt-2 pb-8 space-y-4">
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-1">
                      <button onClick={() => setSection('home')} className="w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                        <ChevronDown size={14} className="rotate-90" />
                      </button>
                      <div>
                        <h2 className="text-[15px] font-black tracking-tight">Alarms & Reminders</h2>
                        <p className="text-[9px] text-white/25 tracking-widest uppercase mt-0.5">Notification settings</p>
                      </div>
                      <button onClick={onClose} className="ml-auto w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                        <X size={14} />
                      </button>
                    </div>

                    {/* ── Vibrate mode sync banner ── */}
                    {isNative && ringerMode === 'vibrate' && (
                      <div className="rounded-2xl border border-[#8B5CF6]/25 bg-[#8B5CF6]/[0.07] px-4 py-3 flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-[#8B5CF6]/15 border border-[#8B5CF6]/25 flex items-center justify-center shrink-0">
                          <Vibrate size={16} className="text-[#8B5CF6]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-bold text-[#8B5CF6]">Vibrate Mode Active</div>
                          <div className="text-[9px] text-white/40 mt-0.5">Ringtones muted — alerts will vibrate only</div>
                        </div>
                        <motion.div animate={{ scale: [1, 1.18, 1] }} transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}>
                          <Vibrate size={14} className="text-[#8B5CF6]/50 shrink-0" />
                        </motion.div>
                      </div>
                    )}

                    {/* ── Notifications card ── */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">

                      {/* Session Alerts row */}
                      <div className="px-4 py-4 flex items-center justify-between gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shrink-0 transition-all ${alertsEnabled ? 'bg-emerald-500/15 border-emerald-500/30' : 'bg-white/[0.04] border-white/[0.08]'}`}>
                          {alertsEnabled ? <Bell size={17} className="text-emerald-400" /> : <BellOff size={17} className="text-white/30" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-bold text-white/85">Session Alerts</div>
                          <div className="text-[10px] mt-0.5">
                            {!notifGranted
                              ? <button onClick={async () => { const p = await requestPermission(); if (p === 'granted') toast.success('Permission granted!'); }}
                                  className="text-orange-400/90 font-semibold flex items-center gap-1">
                                  <AlertCircle size={9} />Permission required — tap to allow
                                </button>
                              : <span className="text-white/30">Fires when a session opens</span>}
                          </div>
                        </div>
                        <button onClick={async () => {
                          const next = !alertsEnabled;
                          if (next) {
                            const perm = await requestPermission();
                            if (isNative) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                            if (perm === 'granted') toast.success('Session alerts on');
                            else if (perm === 'denied') toast.error('Permission denied', { description: 'Enable notifications in device settings.' });
                          } else { toast.info('Session alerts off'); }
                          setAlertsEnabled(next);
                        }}>
                          {alertsEnabled ? <ToggleRight size={34} className="text-emerald-400" /> : <ToggleLeft size={34} className="text-white/20" />}
                        </button>
                      </div>

                      <div className="h-px bg-white/[0.04] mx-4" />

                      {/* Interval Reminders row */}
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shrink-0 transition-all ${reminderMode !== 'off' ? 'bg-[#8B5CF6]/15 border-[#8B5CF6]/30' : 'bg-white/[0.04] border-white/[0.08]'}`}>
                            <Timer size={17} className={reminderMode !== 'off' ? 'text-[#8B5CF6]' : 'text-white/30'} />
                          </div>
                          <div className="flex-1">
                            <div className="text-[13px] font-bold text-white/85">Interval Reminders</div>
                            <div className="text-[10px] text-white/30 mt-0.5">Fires every 15 min during sessions</div>
                          </div>
                          {reminderMode !== 'off' && (
                            <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 1.4 }} className="w-2 h-2 rounded-full bg-[#8B5CF6] shrink-0" />
                          )}
                        </div>
                        <div className="flex gap-2">
                          {([
                            { mode: 'off', label: 'Off' },
                            { mode: 'once', label: 'Once' },
                            { mode: 'continuous', label: 'Repeat' },
                          ] as const).map(({ mode, label }) => (
                            <button key={mode}
                              onClick={() => {
                                setReminderMode(mode);
                                if (mode === 'once') toast.success('One reminder queued');
                                else if (mode === 'continuous') toast.success('Repeating reminders on');
                                else toast.info('Reminders off');
                              }}
                              className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all ${
                                reminderMode === mode
                                  ? mode === 'off' ? 'bg-white/[0.08] border-white/[0.15] text-white/70'
                                    : 'bg-[#8B5CF6]/15 border-[#8B5CF6]/35 text-[#8B5CF6]'
                                  : 'bg-white/[0.02] border-white/[0.06] text-white/25 hover:text-white/50'
                              }`}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* ── Sounds card ── */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-white/[0.04]">
                        <span className="text-[8px] font-black tracking-[0.3em] uppercase text-white/25">Sounds</span>
                      </div>

                      {/* Reminder tone row */}
                      <button
                        onClick={async () => {
                          if (isNative) {
                            try { const res = await SessionAlarm.pickReminderRingtone(); if (res.name) { setReminderRingtoneName(res.name); toast.success('Reminder tone set', { description: res.name }); } } catch {}
                          } else { setExpandedSound(expandedSound === 'reminder' ? null : 'reminder'); }
                        }}
                        className="w-full px-4 py-3.5 flex items-center gap-3 hover:bg-white/[0.015] transition-colors">
                        <div className="w-9 h-9 rounded-xl bg-[#8B5CF6]/10 border border-[#8B5CF6]/20 flex items-center justify-center shrink-0">
                          <Timer size={14} className="text-[#8B5CF6]" />
                        </div>
                        <div className="flex-1 text-left">
                          <div className="text-[12px] font-bold text-white/80">Reminder Tone</div>
                          <div className="text-[10px] text-white/35 mt-0.5 truncate">
                            {isNative ? reminderRingtoneName : (WEB_RINGTONES.find(r => r.id === webReminderRingtoneId)?.name ?? '—')}
                          </div>
                        </div>
                        {isNative
                          ? <ChevronRight size={13} className="text-white/20 shrink-0" />
                          : expandedSound === 'reminder'
                            ? <ChevronUp size={13} className="text-white/40 shrink-0" />
                            : <ChevronDown size={13} className="text-white/20 shrink-0" />}
                      </button>

                      {/* Reminder tone picker (web only) */}
                      {!isNative && expandedSound === 'reminder' && (
                        <div className="px-4 pb-3 space-y-1.5">
                          {WEB_RINGTONES.map(r => (
                            <div key={r.id} className="flex items-center gap-2">
                              <button onClick={() => { setWebReminderRingtoneId(r.id); toast.success('Reminder tone selected', { description: r.name }); }}
                                className={`flex-1 flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
                                  webReminderRingtoneId === r.id
                                    ? 'bg-[#8B5CF6]/10 border-[#8B5CF6]/25 text-[#8B5CF6]'
                                    : 'bg-white/[0.02] border-white/[0.05] text-white/40 hover:text-white/70'
                                }`}>
                                <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${webReminderRingtoneId === r.id ? 'border-[#8B5CF6]' : 'border-white/20'}`}>
                                  {webReminderRingtoneId === r.id && <div className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6]" />}
                                </div>
                                <span className="text-[11px] font-semibold">{r.name}</span>
                              </button>
                              <button onClick={() => { const a = new Audio(r.url); a.volume = 0.5; a.play().catch(() => {}); }}
                                className="w-8 h-8 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors shrink-0">
                                <Play size={10} className="ml-0.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="h-px bg-white/[0.04] mx-4" />

                      {/* Session tone row */}
                      <button
                        onClick={async () => {
                          if (isNative) {
                            try { const res = await SessionAlarm.pickSessionRingtone(); if (res.name) { setSessionRingtoneName(res.name); toast.success('Session tone set', { description: res.name }); } } catch {}
                          } else { setExpandedSound(expandedSound === 'session' ? null : 'session'); }
                        }}
                        className="w-full px-4 py-3.5 flex items-center gap-3 hover:bg-white/[0.015] transition-colors">
                        <div className="w-9 h-9 rounded-xl bg-[#3B82F6]/10 border border-[#3B82F6]/20 flex items-center justify-center shrink-0">
                          <Bell size={14} className="text-[#3B82F6]" />
                        </div>
                        <div className="flex-1 text-left">
                          <div className="text-[12px] font-bold text-white/80">Session Start Tone</div>
                          <div className="text-[10px] text-white/35 mt-0.5 truncate">
                            {isNative ? sessionRingtoneName : (WEB_RINGTONES.find(r => r.id === webSessionRingtoneId)?.name ?? '—')}
                          </div>
                        </div>
                        {isNative
                          ? <ChevronRight size={13} className="text-white/20 shrink-0" />
                          : expandedSound === 'session'
                            ? <ChevronUp size={13} className="text-white/40 shrink-0" />
                            : <ChevronDown size={13} className="text-white/20 shrink-0" />}
                      </button>

                      {/* Session tone picker (web only) */}
                      {!isNative && expandedSound === 'session' && (
                        <div className="px-4 pb-3 space-y-1.5">
                          {WEB_RINGTONES.map(r => (
                            <div key={r.id} className="flex items-center gap-2">
                              <button onClick={() => { setWebSessionRingtoneId(r.id); toast.success('Session tone selected', { description: r.name }); }}
                                className={`flex-1 flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
                                  webSessionRingtoneId === r.id
                                    ? 'bg-[#3B82F6]/10 border-[#3B82F6]/25 text-[#3B82F6]'
                                    : 'bg-white/[0.02] border-white/[0.05] text-white/40 hover:text-white/70'
                                }`}>
                                <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${webSessionRingtoneId === r.id ? 'border-[#3B82F6]' : 'border-white/20'}`}>
                                  {webSessionRingtoneId === r.id && <div className="w-1.5 h-1.5 rounded-full bg-[#3B82F6]" />}
                                </div>
                                <span className="text-[11px] font-semibold">{r.name}</span>
                              </button>
                              <button onClick={() => { const a = new Audio(r.url); a.volume = 0.5; a.play().catch(() => {}); }}
                                className="w-8 h-8 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors shrink-0">
                                <Play size={10} className="ml-0.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* ── Test notifications card ── */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-white/[0.04]">
                        <span className="text-[8px] font-black tracking-[0.3em] uppercase text-white/25">Test</span>
                      </div>
                      <div className="divide-y divide-white/[0.04]">
                        <button onClick={async () => { await sendNotification('Session Open', 'NY Open — New York session is now live.'); if (!isNative) playAlertSound(); }}
                          className="w-full px-4 py-3.5 flex items-center gap-3 group hover:bg-white/[0.015] transition-colors">
                          <div className="w-9 h-9 rounded-xl bg-[#3B82F6]/10 border border-[#3B82F6]/20 flex items-center justify-center shrink-0">
                            <Bell size={14} className="text-[#3B82F6]" />
                          </div>
                          <div className="flex-1 text-left">
                            <div className="text-[12px] font-bold text-white/80">Test Session Alert</div>
                            <div className="text-[10px] text-white/30 mt-0.5">Fires a sample session notification</div>
                          </div>
                          <ChevronRight size={13} className="text-white/20 group-hover:text-white/50 transition-colors shrink-0" />
                        </button>
                        <button onClick={async () => { await sendReminderNotification('NY Open — Interval 2/6', 'Closes in 45m. 30m elapsed.'); if (!isNative) playReminderSound(); }}
                          className="w-full px-4 py-3.5 flex items-center gap-3 group hover:bg-white/[0.015] transition-colors">
                          <div className="w-9 h-9 rounded-xl bg-[#8B5CF6]/10 border border-[#8B5CF6]/20 flex items-center justify-center shrink-0">
                            <Timer size={14} className="text-[#8B5CF6]" />
                          </div>
                          <div className="flex-1 text-left">
                            <div className="text-[12px] font-bold text-white/80">Test Reminder</div>
                            <div className="text-[10px] text-white/30 mt-0.5">Fires a sample 15-min reminder</div>
                          </div>
                          <ChevronRight size={13} className="text-white/20 group-hover:text-white/50 transition-colors shrink-0" />
                        </button>
                        {isNative && (
                          <button onClick={async () => {
                            try { await SessionAlarm.testAlarm({ delaySec: 10 }); toast.success('Test alarm in 10s', { description: 'Lock your screen to verify delivery.', duration: 10000 }); }
                            catch (e) { toast.error('Failed', { description: String(e) }); }
                          }} className="w-full px-4 py-3.5 flex items-center gap-3 group hover:bg-white/[0.015] transition-colors">
                            <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                              <AlarmClock size={14} className="text-red-400" />
                            </div>
                            <div className="flex-1 text-left">
                              <div className="text-[12px] font-bold text-white/80">Test Alarm (10s)</div>
                              <div className="text-[10px] text-white/30 mt-0.5">Lock screen to verify delivery</div>
                            </div>
                            <ChevronRight size={13} className="text-white/20 group-hover:text-white/50 transition-colors shrink-0" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* ── Android Setup card ── */}
                    {isNative && (
                      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-white/[0.04]">
                          <span className="text-[8px] font-black tracking-[0.3em] uppercase text-white/25">Android Setup</span>
                        </div>
                        <div className="divide-y divide-white/[0.04]">
                          {[
                            { icon: <BatteryCharging size={15} className="text-orange-400" />, bg: 'bg-orange-500/10 border-orange-500/20', label: 'Battery Optimization', sub: 'Disable for reliable alarm delivery',
                              action: async () => {
                                const res = await SessionAlarm.requestIgnoreBatteryOptimization().catch(() => ({ alreadyIgnoring: false }));
                                if (res.alreadyIgnoring) { setBatteryOptOff(true); toast.success('Unrestricted mode active'); }
                                else toast.info('System dialog opened', { description: 'Select "Allow" to enable.' });
                              }, status: batteryOptOff },
                            { icon: <AlarmClock size={15} className="text-yellow-400" />, bg: 'bg-yellow-500/10 border-yellow-500/20', label: 'Exact Alarm Permission', sub: 'Required on Android 12+',
                              action: async () => {
                                const res = await SessionAlarm.getExactAlarmStatus().catch(() => ({ canScheduleExactAlarms: false }));
                                if (res.canScheduleExactAlarms) { setCanExactAlarm(true); toast.success('Exact alarms permitted'); }
                                else { await SessionAlarm.openExactAlarmSettings().catch(() => {}); toast.info('Settings opened'); }
                              }, status: canExactAlarm },
                          ].map(({ icon, bg, label, sub, action, status }) => (
                            <button key={label} onClick={action} className="w-full px-4 py-3.5 flex items-center gap-3 group hover:bg-white/[0.015] transition-colors">
                              <div className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${bg}`}>{icon}</div>
                              <div className="flex-1 text-left">
                                <div className="text-[12px] font-bold text-white/80">{label}</div>
                                <div className="text-[10px] text-white/30 mt-0.5">{sub}</div>
                              </div>
                              {status === true ? <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                                : status === false ? <AlertCircle size={14} className="text-orange-400/70 shrink-0" />
                                : <ChevronRight size={13} className="text-white/20 group-hover:text-white/50 transition-colors shrink-0" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* ── Calendar ── */}
                {section === 'calendar' && (
                  <motion.div key="calendar" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.2 }}
                    className="pb-6">
                    <div className="flex items-center gap-3 px-5 pt-2 pb-3">
                      <button onClick={() => setSection('home')} className="w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                        <ChevronDown size={14} className="rotate-90" />
                      </button>
                      <div>
                        <h2 className="text-[15px] font-black tracking-tight">Economic Calendar</h2>
                        <p className="text-[9px] text-white/25 tracking-widest uppercase mt-0.5">US · GB · EU · JP · CA · AU</p>
                      </div>
                      <button onClick={onClose} className="ml-auto w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                        <X size={14} />
                      </button>
                    </div>
                    <div className="px-3">
                      <EconomicCalendar />
                    </div>
                    <div className="px-5 pt-2 flex items-center gap-1.5">
                      <AlertCircle size={9} className="text-white/15 shrink-0" />
                      <p className="text-[8px] text-white/15">Economic data by TradingView</p>
                    </div>
                  </motion.div>
                )}

                {/* ── Fundamentals ── */}
                {section === 'fundamentals' && (
                  <motion.div key="fundamentals" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.2 }}
                    className="px-5 pt-2 pb-8 space-y-4">
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-1">
                      <button onClick={() => setSection('home')} className="w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                        <ChevronDown size={14} className="rotate-90" />
                      </button>
                      <div>
                        <h2 className="text-[15px] font-black tracking-tight">XAUUSD Fundamentals</h2>
                        <p className="text-[9px] text-white/25 tracking-widest uppercase mt-0.5">Gold market bias · via Grok AI</p>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        {/* Make.com trigger button — fires the scenario then auto-fetches */}
                        <button
                          onClick={onTriggerMake}
                          disabled={fundamentalsLoading || makeTriggered}
                          title={makeTriggered ? 'Make.com triggered — fetching…' : 'Trigger Make.com scenario'}
                          className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-all disabled:opacity-50 ${
                            makeTriggered
                              ? 'bg-[#EAB308]/15 border-[#EAB308]/30 text-[#EAB308]'
                              : 'bg-white/[0.05] border-white/[0.07] text-white/35 hover:text-white/70'
                          }`}>
                          <RefreshCw size={13} className={fundamentalsLoading || makeTriggered ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/35 hover:text-white/70 transition-colors">
                          <X size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Make.com trigger status */}
                    {makeTriggered && !fundamentalsLoading && (
                      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                        className="rounded-2xl border border-[#EAB308]/25 bg-[#EAB308]/[0.07] px-4 py-3 flex items-center gap-3">
                        <RefreshCw size={13} className="text-[#EAB308] animate-spin shrink-0" />
                        <div>
                          <div className="text-[11px] font-bold text-[#EAB308]">Make.com triggered</div>
                          <div className="text-[9px] text-white/40 mt-0.5">Fetching latest email — updating in a moment…</div>
                        </div>
                      </motion.div>
                    )}

                    {/* Loading skeleton */}
                    {fundamentalsLoading && !fundamentals && (
                      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-xl bg-white/[0.04] animate-pulse" />
                          <div className="flex-1 space-y-2">
                            <div className="h-4 w-24 rounded-lg bg-white/[0.06] animate-pulse" />
                            <div className="h-3 w-40 rounded-lg bg-white/[0.04] animate-pulse" />
                          </div>
                        </div>
                        <div className="space-y-2 mt-2">
                          <div className="h-3 w-full rounded-lg bg-white/[0.04] animate-pulse" />
                          <div className="h-3 w-4/5 rounded-lg bg-white/[0.04] animate-pulse" />
                          <div className="h-3 w-3/5 rounded-lg bg-white/[0.04] animate-pulse" />
                        </div>
                      </div>
                    )}

                    {/* Error */}
                    {fundamentalsError && (
                      <div className="rounded-2xl border border-red-500/20 bg-red-500/05 px-4 py-4 flex items-start gap-3">
                        <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                        <div>
                          <div className="text-[12px] font-bold text-red-400 mb-0.5">Fetch failed</div>
                          <div className="text-[10px] text-white/40">{fundamentalsError}</div>
                        </div>
                      </div>
                    )}

                    {/* Bias card */}
                    {fundamentals && (() => {
                      const biasColor = fundamentals.bias === 'bullish' ? '#10B981'
                        : fundamentals.bias === 'bearish' ? '#EF4444' : '#EAB308';
                      const BiasIcon = fundamentals.bias === 'bullish' ? TrendingUp
                        : fundamentals.bias === 'bearish' ? TrendingDown : Minus;
                      return (
                        <div className="relative rounded-2xl overflow-hidden"
                          style={{ background: `linear-gradient(135deg, ${biasColor}0E 0%, ${biasColor}04 100%)`, border: `1px solid ${biasColor}30` }}>
                          <div className="absolute top-0 right-0 w-32 h-32 rounded-full opacity-10 pointer-events-none" style={{ background: biasColor, filter: 'blur(40px)' }} />

                          {/* Header */}
                          <div className="px-4 pt-4 pb-3 flex items-center gap-3">
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center border"
                              style={{ background: `${biasColor}18`, borderColor: `${biasColor}30` }}>
                              <BiasIcon size={20} style={{ color: biasColor }} />
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: biasColor }}>
                                  {fundamentals.bias}
                                </span>
                                {fundamentalsLoading && (
                                  <RefreshCw size={9} className="animate-spin" style={{ color: biasColor }} />
                                )}
                              </div>
                              <div className="text-[12px] font-bold text-white/70 leading-tight">{fundamentals.subject}</div>
                            </div>
                          </div>

                          <div className="h-px mx-4" style={{ background: `${biasColor}18` }} />

                          {/* Summary */}
                          <div className="px-4 py-3 space-y-2">
                            {(fundamentals.summary || 'No summary extracted.')
                              .split('\n\n')
                              .filter(p => p.trim())
                              .map((p, i) => (
                                <p key={i} className="text-[11px] text-white/55 leading-[1.7]">{p.trim()}</p>
                              ))}
                          </div>

                          <div className="h-px mx-4" style={{ background: `${biasColor}18` }} />

                          {/* Footer */}
                          <div className="px-4 py-2.5 flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full" style={{ background: `${biasColor}80` }} />
                              <span className="text-[8px] font-bold uppercase tracking-wider text-white/25">via Grok AI</span>
                            </div>
                            <span className="text-[8px] font-mono text-white/20">
                              {fundamentals.date
                                ? new Date(fundamentals.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : `Fetched ${new Date(fundamentals.fetchedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
                              }
                            </span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Empty state */}
                    {!fundamentalsLoading && !fundamentalsError && !fundamentals && (
                      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-6 flex flex-col items-center gap-2 text-center">
                        <Mail size={20} className="text-white/15" />
                        <div className="text-[12px] font-bold text-white/40">No analysis found</div>
                        <p className="text-[10px] text-white/25 max-w-[200px] leading-relaxed">
                          No Grok AI emails with XAUUSD/Gold/Fundamentals in the subject were found.
                        </p>
                      </div>
                    )}
                  </motion.div>
                )}

              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────
function Onboarding({
  isNative, isDark, onComplete, onRequestPermission, onRequestExactAlarm, onRequestBattery,
}: {
  isNative: boolean;
  isDark: boolean;
  onComplete: () => void;
  onRequestPermission: () => Promise<'granted' | 'denied' | 'default'>;
  onRequestExactAlarm: () => Promise<void>;
  onRequestBattery: () => Promise<void>;
}) {
  const allSteps: string[] = [
    'welcome', 'notifications',
    ...(isNative ? ['alarms', 'battery'] : []),
    'done',
  ];
  const [step, setStep] = useState(0);
  const [busy, setBusy]  = useState(false);
  const id = allSteps[step];
  const isLast = step === allSteps.length - 1;

  const advance = () => { if (isLast) onComplete(); else setStep(s => s + 1); };

  const handlePrimary = async () => {
    setBusy(true);
    try {
      if (id === 'notifications') await onRequestPermission();
      else if (id === 'alarms')   await onRequestExactAlarm();
      else if (id === 'battery')  await onRequestBattery();
    } catch {}
    setBusy(false);
    advance();
  };

  type StepInfo = { icon: React.ReactElement; color: string; title: string; sub: string; body: string; action: string; skippable: boolean };
  const INFO: Record<string, StepInfo> = {
    welcome: {
      icon: <TrendingUp size={30} className="text-white" />,
      color: '#3B82F6',
      title: 'Welcome to\nMarket Watch',
      sub: 'Real-time forex session tracker',
      body: 'See which sessions are live, track countdowns to the second, get alerted when sessions open, and follow the economic calendar — all in one place.',
      action: 'Get Started',
      skippable: false,
    },
    notifications: {
      icon: <Bell size={30} className="text-white" />,
      color: '#10B981',
      title: 'Stay Ahead\nof the Market',
      sub: 'Session alerts & notifications',
      body: "When London opens, when New York fires — you'll know instantly. We need permission to notify you so no session start catches you off guard.",
      action: 'Enable Notifications',
      skippable: true,
    },
    alarms: {
      icon: <AlarmClock size={30} className="text-white" />,
      color: '#8B5CF6',
      title: 'Pinpoint\nAccuracy',
      sub: 'Exact alarm scheduling',
      body: 'Markets open at a precise minute. Your alerts should fire exactly then — not a few minutes later. This setting unlocks that accuracy on Android.',
      action: 'Allow Exact Alarms',
      skippable: true,
    },
    battery: {
      icon: <BatteryCharging size={30} className="text-white" />,
      color: '#F27D26',
      title: 'Never Miss\nan Open',
      sub: 'Background reliability',
      body: "Android can pause background apps to save battery — silencing your alarms. Exempting this app ensures session alerts always fire, even when you're away.",
      action: 'Keep Alerts Reliable',
      skippable: true,
    },
    done: {
      icon: <CheckCircle2 size={30} className="text-white" />,
      color: '#10B981',
      title: "You're\nAll Set!",
      sub: 'Market Session Watch is ready',
      body: 'Tap the ⊞ grid icon at the top right to access alarms, economic calendar, and settings. Good luck in the markets!',
      action: 'Start Watching',
      skippable: false,
    },
  };

  const c = INFO[id] ?? INFO['welcome'];

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-[200] flex flex-col bg-[var(--bg-base)] text-[var(--text-base)] font-sans select-none"
    >
      {/* Step dots */}
      <div className="flex justify-center gap-2 pt-14 pb-4">
        {allSteps.map((_, i) => (
          <motion.div key={i}
            animate={{ width: i === step ? 24 : 7, backgroundColor: i === step ? c.color : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)') }}
            transition={{ duration: 0.35 }}
            style={{ height: 7, borderRadius: 9999 }}
          />
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 pb-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={id}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            className="flex flex-col items-center text-center"
          >
            {/* Icon orb */}
            <div className="relative mb-10">
              <div className="absolute rounded-full blur-3xl opacity-20 pointer-events-none"
                style={{ background: c.color, inset: '-40%' }} />
              <div className="relative w-[88px] h-[88px] rounded-[26px] flex items-center justify-center border border-white/[0.1]"
                style={{ background: `linear-gradient(135deg, ${c.color}28 0%, ${c.color}0C 100%)` }}>
                {c.icon}
              </div>
            </div>

            <h1 className="text-[34px] font-black tracking-tight leading-[1.12] whitespace-pre-line mb-3">
              {c.title}
            </h1>

            <p className="text-[10px] font-black tracking-[0.3em] uppercase mb-6" style={{ color: `${c.color}BB` }}>
              {c.sub}
            </p>

            <p className="text-[14px] text-white/40 leading-[1.7] max-w-[280px]">
              {c.body}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Actions */}
      <div className="px-6 pb-14 flex flex-col items-center gap-3">
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={handlePrimary}
          disabled={busy}
          className="w-full max-w-xs rounded-2xl py-[18px] text-[15px] font-black tracking-wide"
          style={{
            background: `linear-gradient(135deg, ${c.color} 0%, ${c.color}CC 100%)`,
            boxShadow: `0 10px 36px -10px ${c.color}70`,
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? 'Please wait…' : c.action}
        </motion.button>

        {c.skippable && (
          <button onClick={advance}
            className="text-[12px] text-white/25 hover:text-white/50 transition-colors py-2 px-4">
            Skip for now
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────
export default function App() {
  const [now, setNow]                     = useState(new Date());
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [localTimeZone, setLocalTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [notifGranted, setNotifGranted]   = useState(false);
  const prevActiveSessions                = useRef<string[]>([]);
  const notifIdRef                        = useRef(1);
  const isNative                          = Capacitor.isNativePlatform();

  const [showPanel, setShowPanel]         = useState(false);
  const showPanelRef                      = useRef(false);
  const [reminderMode, setReminderMode]   = useState<'off' | 'once' | 'continuous'>('off');
  const reminderIntervalRef               = useRef<ReturnType<typeof setInterval> | null>(null);
  const reminderTimeoutRef                = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sessionRingtoneName, setSessionRingtoneName]     = useState<string>('Not set');
  const [reminderRingtoneName, setReminderRingtoneName]   = useState<string>('Not set');
  const [webSessionRingtoneId, setWebSessionRingtoneId]   = useState<string>('chime');
  const [webReminderRingtoneId, setWebReminderRingtoneId] = useState<string>('bell');

  const [batteryOptOff, setBatteryOptOff] = useState<boolean | null>(null);
  const [canExactAlarm, setCanExactAlarm] = useState<boolean | null>(null);
  const [showDevPanel, setShowDevPanel]   = useState(false);
  const longPressTimer                    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDark, setIsDark]               = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [ringerMode, setRingerMode]       = useState<'normal' | 'silent' | 'vibrate' | null>(null);

  // ─── Timezone picker state ────────────────────────────────────────
  const [showTzPicker, setShowTzPicker] = useState(false);
  const [tzSearch, setTzSearch]         = useState('');

  const allTimezones = useMemo(() => {
    try { return (Intl as any).supportedValuesOf('timeZone') as string[]; }
    catch { return ['UTC','America/New_York','Europe/London','Asia/Tokyo','Australia/Sydney','Africa/Johannesburg']; }
  }, []);

  const filteredTimezones = useMemo(() => {
    const q = tzSearch.toLowerCase().trim();
    if (!q) return allTimezones;
    return allTimezones.filter(tz => tz.toLowerCase().includes(q));
  }, [allTimezones, tzSearch]);

  const tzDisplayName = useMemo(() => {
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (localTimeZone === localTz) return 'Local';
    return localTimeZone.split('/').pop()?.replace(/_/g, ' ') ?? localTimeZone;
  }, [localTimeZone]);

  // ─── Fundamentals state ───────────────────────────────────────────
  const [fundamentals, setFundamentals]               = useState<FundamentalsData | null>(() => getCachedFundamentals());
  const [fundamentalsLoading, setFundamentalsLoading] = useState(false);
  const [fundamentalsError, setFundamentalsError]     = useState<string | null>(null);
  const [makeTriggered, setMakeTriggered]             = useState(false);

  // Show onboarding on first launch
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try { return !localStorage.getItem('onboardingDone'); } catch { return false; }
  });

  // Keep ref in sync so back-button listener always sees latest value
  useEffect(() => { showPanelRef.current = showPanel; }, [showPanel]);

  // ─── Status bar + theme ─────────────────────────────────────────
  useEffect(() => {
    const applyTheme = (dark: boolean) => {
      setIsDark(dark);
      const bgColor = dark ? '#050508' : '#F2F1FA';
      if (isNative) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
        StatusBar.setBackgroundColor({ color: bgColor }).catch(() => {});
      }
      // Keep meta theme-color in sync for browser chrome
      document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
        const media = m.getAttribute('media');
        if (!media || media.includes(dark ? 'dark' : 'light')) {
          m.setAttribute('content', bgColor);
        }
      });
    };

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(mq.matches);
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [isNative]);

  useEffect(() => {
    if (isNative) {
      LocalNotifications.checkPermissions().then(({ display }) => setNotifGranted(display === 'granted')).catch(() => {});
    } else if (typeof Notification !== 'undefined') {
      setNotifGranted(Notification.permission === 'granted');
    }
  }, [isNative]);

  // ─── Ringer mode detection ───────────────────────────────────────
  // Read current ringer mode on mount so UI reflects system state immediately.
  useEffect(() => {
    if (!isNative) return;
    SessionAlarm.getRingerMode()
      .then(({ mode }) => setRingerMode(mode as 'normal' | 'silent' | 'vibrate'))
      .catch(() => {});
  }, [isNative]);

  useEffect(() => {
    const saved = localStorage.getItem('marketSessionSettings');
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.alertsEnabled !== undefined) setAlertsEnabled(s.alertsEnabled);
        // On native, reminderMode is authoritative from the SessionAlarm plugin (loaded below)
        if (s.reminderMode && !isNative) setReminderMode(s.reminderMode);
        if (s.localTimeZone) setLocalTimeZone(s.localTimeZone);
        if (s.webSessionRingtoneId) setWebSessionRingtoneId(s.webSessionRingtoneId);
        if (s.webReminderRingtoneId) setWebReminderRingtoneId(s.webReminderRingtoneId);
      } catch {}
    }
  }, [isNative]);

  useEffect(() => {
    // Save on both web and native so settings survive app restarts
    localStorage.setItem('marketSessionSettings', JSON.stringify({
      alertsEnabled, reminderMode, localTimeZone,
      webSessionRingtoneId, webReminderRingtoneId,
    }));
  }, [alertsEnabled, reminderMode, localTimeZone, webSessionRingtoneId, webReminderRingtoneId]);

  useEffect(() => {
    if (!isNative) return;

    CapApp.addListener('appStateChange', (state: { isActive: boolean }) => {
      if (state.isActive) {
        setNow(new Date());
        // Re-read ringer mode in case user changed it while the app was in background
        SessionAlarm.getRingerMode()
          .then(({ mode }) => setRingerMode(mode as 'normal' | 'silent' | 'vibrate'))
          .catch(() => {});
      }
    });

    // Hardware back button: close open panel first, otherwise exit the app
    CapApp.addListener('backButton', () => {
      if (showPanelRef.current) {
        setShowPanel(false);
      } else {
        CapApp.exitApp();
      }
    });

    return () => { CapApp.removeAllListeners(); };
  }, [isNative]);

  // Fetch fundamentals on mount + every 30 min
  useEffect(() => {
    fetchFundamentals(true);
    const timer = setInterval(() => fetchFundamentals(true), 30 * 60 * 1000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ─── Time ────────────────────────────────────────────────────────
  const nowInNY = toZonedTime(now, TIMEZONE);
  const timeStr = formatInTimeZone(now, TIMEZONE, 'HH:mm:ss');
  const dateStr = formatInTimeZone(now, TIMEZONE, 'EEE, MMM d');

  const getLocalTime = (utcStr: string) => {
    try {
      const today = formatInTimeZone(now, 'UTC', 'yyyy-MM-dd');
      const [y, mo, d] = today.split('-').map(Number);
      const [h, m] = utcStr.split(':').map(Number);
      return formatInTimeZone(new Date(Date.UTC(y, mo - 1, d, h, m)), localTimeZone, 'HH:mm');
    } catch { return utcStr; }
  };

  // ─── Sessions ────────────────────────────────────────────────────
  const activeSessions = SESSIONS.filter(s => isSessionActive(s, nowInNY));
  const currentSession = [...activeSessions].sort((a, b) => {
    const [aH, aM] = a.end.split(':').map(Number);
    const [bH, bM] = b.end.split(':').map(Number);
    return (aH * 60 + aM) - (bH * 60 + bM);
  })[0] ?? null;

  const cur = nowInNY.getHours() * 60 + nowInNY.getMinutes();
  const upcomingSessions = [...SESSIONS]
    .filter(s => !isSessionActive(s, nowInNY))
    .sort((a, b) => {
      const aT = +a.start.split(':')[0] * 60 + +a.start.split(':')[1];
      const bT = +b.start.split(':')[0] * 60 + +b.start.split(':')[1];
      return (((aT - cur) + 1440) % 1440) - (((bT - cur) + 1440) % 1440);
    })
    .slice(0, 2);

  const nextSession  = !currentSession ? (upcomingSessions[0] ?? null) : null;
  const countdownStr = currentSession
    ? getCountdown(currentSession.end, nowInNY)
    : upcomingSessions[0] ? getCountdown(upcomingSessions[0].start, nowInNY) : timeStr;

  const ringProgress  = currentSession ? getSessionProgress(currentSession.start, currentSession.end, nowInNY) : 0;
  const dashOffset    = CIRCUMFERENCE * (1 - ringProgress / 100);
  const peakColor     = currentSession ? (currentSession.color || GROUP_CONFIG[currentSession.group].color) : '#2A2A3A';

  const tickMarks = Array.from({ length: 60 }, (_, i) => {
    const angle = (i / 60) * 360 - 90;
    const rad   = (angle * Math.PI) / 180;
    const isMajor = i % 5 === 0;
    const outerR  = RING_R + 14;
    const innerR  = RING_R + 14 - (isMajor ? 9 : 5);
    return { x1: RING_CX + innerR * Math.cos(rad), y1: RING_CY + innerR * Math.sin(rad), x2: RING_CX + outerR * Math.cos(rad), y2: RING_CY + outerR * Math.sin(rad), isMajor };
  });

  const secondAngle = (nowInNY.getSeconds() / 60) * 360 - 90;
  const secondRad   = (secondAngle * Math.PI) / 180;
  const secondDotX  = RING_CX + RING_R * Math.cos(secondRad);
  const secondDotY  = RING_CY + RING_R * Math.sin(secondRad);

  const getIntervalInfo = (session: Session, nowDate: Date) => {
    const [sH, sM] = session.start.split(':').map(Number);
    const [eH, eM] = session.end.split(':').map(Number);
    let durationMin = (eH * 60 + eM) - (sH * 60 + sM);
    if (durationMin <= 0) durationMin += 1440;
    const curMin = nowDate.getHours() * 60 + nowDate.getMinutes();
    const curSec = nowDate.getSeconds();
    let elapsedMin = curMin - (sH * 60 + sM);
    if (elapsedMin < 0) elapsedMin += 1440;
    const elapsedSec     = elapsedMin * 60 + curSec;
    const totalIntervals = Math.floor(durationMin / 15);
    const nextMarkMin    = Math.ceil((elapsedMin + 1) / 15) * 15;
    const nextInterval   = Math.ceil(nextMarkMin / 15);
    const msUntilNextMark = (nextMarkMin * 60 - elapsedSec) * 1000;
    const remainingMin    = durationMin - elapsedMin;
    return { durationMin, totalIntervals, currentInterval: Math.max(1, Math.min(nextInterval, totalIntervals)), nextMarkMin, msUntilNextMark, elapsedMin, remainingMin, isLastInterval: nextMarkMin >= durationMin };
  };

  // ─── Notification channel (Android 8+ requires a channel for heads-up popups) ──
  useEffect(() => {
    if (!isNative) return;
    LocalNotifications.createChannel({
      id:          'bias_updates',
      name:        'XAUUSD Bias Updates',
      description: 'Gold fundamental analysis alerts',
      importance:  5,   // IMPORTANCE_HIGH → shows as heads-up popup like WhatsApp
      visibility:  1,   // VISIBILITY_PUBLIC
      sound:       'default',
      vibration:   true,
      lights:      true,
    }).catch(() => {});
  }, [isNative]);

  // ─── Notifications ───────────────────────────────────────────────
  const requestPermission = async (): Promise<'granted' | 'denied' | 'default'> => {
    if (isNative) {
      try { const { display } = await LocalNotifications.requestPermissions(); const ok = display === 'granted'; setNotifGranted(ok); return ok ? 'granted' : 'denied'; }
      catch { return 'denied'; }
    } else if (typeof Notification !== 'undefined') {
      const p = await Notification.requestPermission(); setNotifGranted(p === 'granted'); return p;
    }
    return 'denied';
  };

  const openExactAlarmSettings = async () => {
    if (isNative) await SessionAlarm.openExactAlarmSettings().catch(() => {});
  };

  const requestBatteryOpt = async () => {
    if (isNative) {
      const res = await SessionAlarm.requestIgnoreBatteryOptimization().catch(() => ({ alreadyIgnoring: false }));
      if ('alreadyIgnoring' in res && res.alreadyIgnoring) setBatteryOptOff(true);
    }
  };

  const playAlertSound = () => {
    const ringtone = WEB_RINGTONES.find(r => r.id === webSessionRingtoneId) ?? WEB_RINGTONES[0];
    const a = new Audio(ringtone.url); a.volume = 0.5; a.play().catch(() => {});
  };

  const playReminderSound = () => {
    const ringtone = WEB_RINGTONES.find(r => r.id === webReminderRingtoneId) ?? WEB_RINGTONES[1];
    const a = new Audio(ringtone.url); a.volume = 0.5; a.play().catch(() => {});
  };

  const sendNotification = async (title: string, body: string) => {
    if (isNative && notifGranted) {
      await LocalNotifications.schedule({
        notifications: [{
          title,
          body,
          id:        notifIdRef.current++,
          channelId: 'bias_updates',          // required for heads-up on Android 8+
          schedule:  { at: new Date(Date.now() + 300) },
          smallIcon: 'ic_stat_icon_config_sample',
          iconColor: '#F27D26',
        }],
      }).catch(() => {});
    } else if (!isNative && notifGranted && typeof Notification !== 'undefined') {
      new Notification(title, { body });
    }
  };

  useEffect(() => {
    if (!isNative) return;
    if (alertsEnabled && notifGranted) SessionAlarm.enable().catch(() => {});
    else SessionAlarm.disable().catch(() => {});
  }, [alertsEnabled, notifGranted, isNative]);

  useEffect(() => {
    if (!isNative) return;
    SessionAlarm.isEnabled().then(({ enabled }) => { if (enabled && alertsEnabled) SessionAlarm.enable().catch(() => {}); }).catch(() => {});
    SessionAlarm.getReminderMode().then(({ mode }) => { if (mode === 'continuous' || mode === 'once') setReminderMode(mode as 'once' | 'continuous'); }).catch(() => {});
    SessionAlarm.getSelectedSessionRingtone().then(({ name }) => { if (name) setSessionRingtoneName(name); }).catch(() => {});
    SessionAlarm.getSelectedReminderRingtone().then(({ name }) => { if (name) setReminderRingtoneName(name); }).catch(() => {});
  }, [isNative]);

  useEffect(() => {
    if (!alertsEnabled) return;
    const currentActive = SESSIONS.filter(s => isSessionActive(s, nowInNY)).map(s => s.id);
    currentActive.forEach(async (sid) => {
      if (!prevActiveSessions.current.includes(sid)) {
        const session = SESSIONS.find(s => s.id === sid);
        if (session) {
          if (isNative) { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); SessionAlarm.dismiss().catch(() => {}); }
          else playAlertSound();
          if (!isNative) await sendNotification(`${session.label} — Open`, `${session.group} session is now live.`);
          toast.success(`${session.label} — Open`, { description: `${session.group} session is now live.`, duration: 5000, icon: <Zap size={16} /> });
        }
      }
    });
    prevActiveSessions.current = currentActive;
  }, [nowInNY, alertsEnabled, notifGranted]);

  const sendReminderNotification = async (overrideTitle?: string, overrideBody?: string) => {
    let title = overrideTitle || '';
    let body  = overrideBody  || '';
    if (!overrideTitle) {
      if (currentSession) {
        const info = getIntervalInfo(currentSession, nowInNY);
        const remH = Math.floor(info.remainingMin / 60); const remM = info.remainingMin % 60;
        const remaining = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;
        title = `${currentSession.label} — Interval ${info.currentInterval} of ${info.totalIntervals}`;
        body  = `Closes in ${remaining}. ${info.elapsedMin}m elapsed.`;
      } else if (nextSession) {
        title = `${nextSession.label} Opens in ${countdownStr}`; body = `${nextSession.group} — ${nextSession.start} UTC.`;
      } else { title = 'Markets Closed'; body = 'No active sessions at this time.'; }
    }
    if (isNative && notifGranted) {
      await LocalNotifications.schedule({ notifications: [{ title, body, id: notifIdRef.current++, schedule: { at: new Date(Date.now() + 300) } }] }).catch(() => {});
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    } else if (!isNative && notifGranted && typeof Notification !== 'undefined') {
      new Notification(title, { body });
      playReminderSound();
    }
    toast.info(title, { description: body, duration: 5000, icon: <Timer size={16} /> });
  };

  useEffect(() => {
    if (isNative) SessionAlarm.setReminderMode({ mode: reminderMode }).catch(() => {});
    if (reminderIntervalRef.current) { clearInterval(reminderIntervalRef.current); reminderIntervalRef.current = null; }
    if (reminderTimeoutRef.current) { clearTimeout(reminderTimeoutRef.current); reminderTimeoutRef.current = null; }
    if (reminderMode === 'off') return;
    const scheduleNextReminder = () => {
      if (reminderTimeoutRef.current) { clearTimeout(reminderTimeoutRef.current); reminderTimeoutRef.current = null; }
      if (currentSession) {
        const info = getIntervalInfo(currentSession, nowInNY);
        reminderTimeoutRef.current = setTimeout(() => {
          if (info.isLastInterval) sendReminderNotification(`${currentSession.label} — Closing Soon`, `The ${currentSession.group} session is ending.`);
          else sendReminderNotification();
          if (reminderMode === 'once') setReminderMode('off'); else scheduleNextReminder();
        }, Math.max(info.isLastInterval ? info.remainingMin * 60 * 1000 : info.msUntilNextMark, 1000));
      } else {
        reminderTimeoutRef.current = setTimeout(() => { sendReminderNotification(); if (reminderMode === 'once') setReminderMode('off'); else scheduleNextReminder(); }, 15 * 60 * 1000);
      }
    };
    sendReminderNotification();
    if (reminderMode === 'continuous') scheduleNextReminder();
    if (reminderMode === 'once') {
      if (currentSession) { const info = getIntervalInfo(currentSession, nowInNY); reminderTimeoutRef.current = setTimeout(() => { sendReminderNotification(); setReminderMode('off'); }, Math.max(info.msUntilNextMark, 1000)); }
      else { reminderTimeoutRef.current = setTimeout(() => { sendReminderNotification(); setReminderMode('off'); }, 15 * 60 * 1000); }
    }
    return () => {
      if (reminderIntervalRef.current) { clearInterval(reminderIntervalRef.current); reminderIntervalRef.current = null; }
      if (reminderTimeoutRef.current) { clearTimeout(reminderTimeoutRef.current); reminderTimeoutRef.current = null; }
    };
  }, [reminderMode]);

  // ─── Fundamentals ────────────────────────────────────────────────
  const fetchFundamentals = async (silent = false) => {
    if (!silent) setFundamentalsLoading(true);
    setFundamentalsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/fundamentals`);
      if (res.status === 404) { setFundamentals(null); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Server error ${res.status}` })) as { error?: string };
        throw new Error(err.error ?? `Server error ${res.status}`);
      }
      const data = await res.json() as FundamentalsData;

      const lastId = getLastKnownEmailId();
      const isNewEmail = lastId !== data.emailId;
      if (isNewEmail) {
        // New email from Grok — send heads-up notification + toast
        await sendNotification(
          `XAUUSD Bias: ${data.bias.toUpperCase()}`,
          data.summary.slice(0, 120) + (data.summary.length > 120 ? '…' : ''),
        );
        if (!silent) {
          toast.success(`Gold Bias Updated: ${data.bias.toUpperCase()}`, {
            description: 'New Grok AI fundamental analysis received.',
            icon: data.bias === 'bullish' ? <TrendingUp size={16} />
              : data.bias === 'bearish' ? <TrendingDown size={16} />
              : <Minus size={16} />,
            duration: 7000,
          });
        }
      }
      setLastKnownEmailId(data.emailId);
      storeCachedFundamentals(data);
      setFundamentals(data);
    } catch (err) {
      if (!silent) setFundamentalsError(String(err).replace('Error: ', ''));
    } finally {
      setFundamentalsLoading(false);
    }
  };

  // ─── Make.com manual trigger ─────────────────────────────────────
  const triggerMakeAndRefresh = async () => {
    setMakeTriggered(true);
    try {
      const res = await fetch(`${API_BASE}/api/fundamentals/trigger`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Trigger failed' })) as { error?: string };
        toast.error('Make.com trigger failed', { description: err.error });
        return;
      }
      toast.success('Make.com triggered', { description: 'Fetching latest email in ~4 seconds…', duration: 4000 });
      // Give Make.com time to fetch the email and POST it back
      setTimeout(() => {
        fetchFundamentals();
        setMakeTriggered(false);
      }, 4500);
    } catch {
      toast.error('Could not reach server', { description: 'Make sure npm run server is running.' });
      setMakeTriggered(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-base)] font-sans overflow-x-hidden flex flex-col">

      {/* ── Top Nav ─────────────────────────────────────────────── */}
      <nav className="flex-none flex items-center justify-between px-5 py-3.5 border-b border-white/[0.05] bg-[var(--bg-nav)] backdrop-blur-xl sticky top-0 z-50">
        {/* Logo — long press opens dev panel */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#3B82F6] to-[#8B5CF6] flex items-center justify-center shadow-lg shadow-blue-500/20 cursor-pointer select-none"
            onTouchStart={() => { longPressTimer.current = setTimeout(() => setShowDevPanel(true), 1500); }}
            onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onTouchCancel={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onMouseDown={() => { longPressTimer.current = setTimeout(() => setShowDevPanel(true), 1500); }}
            onMouseUp={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onMouseLeave={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
          >
            <TrendingUp size={13} className="text-white" />
          </div>
          <div>
            <div className="text-[11px] font-black tracking-[0.15em] uppercase text-white/90">Market Watch</div>
            <div className="text-[8px] font-bold tracking-[0.25em] uppercase text-white/25">Forex Sessions</div>
          </div>
        </div>

        {/* Live pill */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
          <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 1.6 }} className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-[9px] font-black tracking-[0.25em] text-emerald-400 uppercase">Live</span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          {/* Vibrate mode badge — shown when phone ringer is set to vibrate */}
          {isNative && ringerMode === 'vibrate' && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="flex items-center gap-1 px-2 py-1 rounded-full bg-[#8B5CF6]/15 border border-[#8B5CF6]/30"
            >
              <Vibrate size={9} className="text-[#8B5CF6]" />
              <span className="text-[8px] font-black tracking-wider uppercase text-[#8B5CF6]">Vibrate</span>
            </motion.div>
          )}

          {/* Master notification toggle — controls session alerts + interval reminders */}
          <button
            onClick={async () => {
              const next = !alertsEnabled;
              if (next) {
                const perm = await requestPermission();
                if (isNative) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                else playAlertSound();
                if (perm === 'granted') {
                  setReminderMode('continuous');
                  toast.success('All Notifications On', { description: 'Session alerts + interval reminders enabled.' });
                } else if (perm === 'denied') {
                  toast.error('Permission Required', { description: 'Enable notifications in device settings.' });
                }
              } else {
                setReminderMode('off');
                if (isNative) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                toast.info('All Notifications Off', { description: 'Session alerts + reminders disabled.' });
              }
              setAlertsEnabled(next);
            }}
            className={`w-8 h-8 rounded-xl flex items-center justify-center border transition-all duration-300 ${alertsEnabled ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'bg-white/[0.04] border-white/[0.08] text-white/30 hover:text-white/60'}`}
          >
            {alertsEnabled ? <Bell size={14} /> : <BellOff size={14} />}
          </button>

          {/* Feature menu button */}
          <button
            onClick={() => setShowPanel(true)}
            className={`w-8 h-8 rounded-xl flex items-center justify-center border transition-all duration-300 ${showPanel ? 'bg-white/[0.1] border-white/[0.2] text-white' : 'bg-white/[0.04] border-white/[0.08] text-white/40 hover:text-white/70 hover:border-white/[0.14]'}`}
          >
            <LayoutGrid size={14} />
          </button>
        </div>
      </nav>

      {/* ── Watch content ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col px-5 pt-6 pb-6 gap-5 max-w-md mx-auto w-full">

        {/* Watch Face */}
        <div className="relative flex flex-col items-center">
          <div className="absolute rounded-full blur-3xl opacity-20 transition-colors duration-1000 pointer-events-none" style={{ background: peakColor, inset: '15%' }} />
          <div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
            <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} width={RING_SIZE} height={RING_SIZE} className="absolute inset-0">
              {tickMarks.map((t, i) => (
                <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                  stroke={t.isMajor ? (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.14)') : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)')}
                  strokeWidth={t.isMajor ? 1.5 : 1} strokeLinecap="round" />
              ))}
              <circle cx={RING_CX} cy={RING_CY} r={RING_R} fill="none" stroke={isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.09)'} strokeWidth={6} />
              {currentSession && (
                <circle cx={RING_CX} cy={RING_CY} r={RING_R} fill="none" stroke={peakColor} strokeWidth={12}
                  strokeLinecap="round" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={dashOffset}
                  transform={`rotate(-90 ${RING_CX} ${RING_CY})`} opacity={0.18}
                  style={{ transition: 'stroke-dashoffset 1s ease-out, stroke 1s ease', filter: 'blur(3px)' }} />
              )}
              <circle cx={RING_CX} cy={RING_CY} r={RING_R} fill="none" stroke={peakColor} strokeWidth={6}
                strokeLinecap="round" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${RING_CX} ${RING_CY})`}
                style={{ transition: 'stroke-dashoffset 1s ease-out, stroke 1s ease' }} />
              <circle cx={secondDotX} cy={secondDotY} r={3.5} fill={currentSession ? peakColor : (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.18)')}
                style={{ transition: 'cx 0.15s ease, cy 0.15s ease' }} />
            </svg>

            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
              <AnimatePresence mode="wait">
                {currentSession ? (
                  <motion.div key={currentSession.id} initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }} transition={{ duration: 0.4 }} className="flex flex-col items-center gap-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {currentSession.isPeak && <Zap size={9} fill={peakColor} style={{ color: peakColor }} />}
                      <span className="text-[8px] font-black tracking-[0.3em] uppercase" style={{ color: peakColor }}>{currentSession.group}</span>
                    </div>
                    <div className="text-[13px] font-black tracking-tight leading-none text-white">{currentSession.label}</div>
                    <div className="font-mono text-[34px] font-black tracking-tighter tabular-nums leading-none mt-1" style={{ color: isDark ? '#FFFFFF' : '#0D0C14', textShadow: `0 0 30px ${peakColor}80` }}>{countdownStr}</div>
                    <div className="text-[8px] font-bold tracking-[0.25em] uppercase mt-0.5" style={{ color: `${peakColor}99` }}>Ends In</div>
                    <div className="text-[9px] font-mono font-bold text-white/30 mt-1 tracking-wider">{currentSession.start} → {currentSession.end} UTC</div>
                  </motion.div>
                ) : upcomingSessions[0] ? (
                  <motion.div key="upcoming-hero" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }} transition={{ duration: 0.4 }} className="flex flex-col items-center gap-1">
                    <span className="text-[8px] font-black tracking-[0.3em] uppercase text-white/25">Next Session</span>
                    <div className="text-[13px] font-black tracking-tight leading-none text-white/60">{upcomingSessions[0].label}</div>
                    <div className="font-mono text-[34px] font-black tracking-tighter tabular-nums leading-none mt-1 text-white/40">{countdownStr}</div>
                    <div className="text-[8px] font-bold tracking-[0.25em] uppercase mt-0.5 text-white/20">Starts In</div>
                    <div className="text-[9px] font-mono font-bold text-white/20 mt-1 tracking-wider">{upcomingSessions[0].start} → {upcomingSessions[0].end} UTC</div>
                  </motion.div>
                ) : (
                  <motion.div key="idle-hero" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2">
                    <div className="text-[10px] font-black tracking-[0.3em] uppercase text-white/20">Markets Closed</div>
                    <div className="font-mono text-[28px] font-black tracking-tighter tabular-nums text-white/15">{timeStr}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Interval dots */}
          <AnimatePresence>
            {currentSession && (() => {
              const info = getIntervalInfo(currentSession, nowInNY);
              return (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="mt-4 w-full max-w-[220px]">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[8px] font-black tracking-[0.25em] uppercase" style={{ color: `${peakColor}80` }}>Interval {info.currentInterval}/{info.totalIntervals}</span>
                    <span className="text-[8px] font-mono" style={{ color: `${peakColor}99` }}>{Math.round(ringProgress)}%</span>
                  </div>
                  <div className="flex gap-1">
                    {Array.from({ length: info.totalIntervals }).map((_, i) => {
                      const done = i < info.currentInterval - 1; const current = i === info.currentInterval - 1;
                      return <motion.div key={i} className="h-1 rounded-full flex-1"
                        animate={current ? { opacity: [1, 0.4, 1] } : {}} transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
                        style={{ background: done || current ? peakColor : `${peakColor}18`, boxShadow: current ? `0 0 8px ${peakColor}` : 'none' }} />;
                    })}
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[7px] font-black tracking-[0.2em] uppercase text-[#F27D26]/70">Local</span>
                    <span className="text-[8px] font-mono text-[#F27D26]/60">{getLocalTime(currentSession.start)} – {getLocalTime(currentSession.end)}</span>
                  </div>
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* Secondary active sessions */}
        {activeSessions.filter(s => s.id !== currentSession?.id).map(session => {
          const cfg = GROUP_CONFIG[session.group]; const color = session.color || cfg.color;
          const progress = getSessionProgress(session.start, session.end, nowInNY);
          return (
            <motion.div key={session.id} layout initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}
              className="relative rounded-2xl overflow-hidden"
              style={{ background: `linear-gradient(135deg, ${color}14 0%, ${color}05 100%)`, border: `1px solid ${color}30`, boxShadow: `0 0 24px -8px ${color}40` }}>
              <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl" style={{ background: color }} />
              <div className="pl-4 pr-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <motion.div animate={{ scale: [1, 1.5, 1], opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1.8 }} className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                      <span className="text-[8px] font-black tracking-[0.25em] uppercase" style={{ color }}>Active</span>
                    </div>
                    <div className="text-[13px] font-black text-white">{session.label}</div>
                    <div className="text-[9px] font-mono text-white/30 mt-0.5">{session.start} → {session.end} UTC</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[7px] font-bold tracking-[0.2em] uppercase mb-0.5" style={{ color: `${color}80` }}>Ends In</div>
                    <div className="font-mono text-[18px] font-black tabular-nums tracking-tighter text-white">{getCountdown(session.end, nowInNY)}</div>
                  </div>
                </div>
                <div className="mt-2.5 h-[2px] w-full rounded-full bg-white/[0.05] overflow-hidden">
                  <motion.div animate={{ width: `${progress}%` }} transition={{ duration: 1, ease: 'easeOut' }} className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${color}60, ${color})` }} />
                </div>
              </div>
            </motion.div>
          );
        })}

        {/* Upcoming sessions */}
        {upcomingSessions.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <div className="h-px flex-1 bg-white/[0.05]" />
              <span className="text-[7px] font-black tracking-[0.35em] uppercase text-white/20">Upcoming</span>
              <div className="h-px flex-1 bg-white/[0.05]" />
            </div>
            <div className="flex flex-col gap-2">
              <AnimatePresence mode="popLayout">
                {upcomingSessions.map((session, idx) => {
                  const cfg = GROUP_CONFIG[session.group]; const color = session.color || cfg.color; const isNext = idx === 0;
                  return (
                    <motion.div key={session.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: isNext ? 0.9 : 0.5, y: 0 }} exit={{ opacity: 0, y: 10 }}
                      transition={{ duration: 0.35, delay: idx * 0.05 }} className="relative rounded-2xl overflow-hidden"
                      style={{ background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)', border: `1px solid ${isNext ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.11)') : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.07)')}` }}>
                      <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl" style={{ background: `${color}40` }} />
                      <div className="pl-4 pr-4 py-3 flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {isNext && <span className="text-[7px] font-black tracking-[0.25em] uppercase text-[#F27D26]/70">Next</span>}
                            {session.isPeak && <Zap size={8} style={{ color: `${color}60` }} />}
                          </div>
                          <div className="text-[13px] font-bold" style={{ color: isNext ? `${color}CC` : (isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.40)') }}>{session.label}</div>
                          <div className="text-[9px] font-mono text-white/20 mt-0.5">{session.start} UTC · {getSessionDuration(session.start, session.end)}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[7px] font-bold tracking-[0.2em] uppercase mb-0.5 text-white/20">Starts in</div>
                          <div className="font-mono text-[16px] font-black tabular-nums tracking-tighter" style={{ color: isNext ? (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.60)') : (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.30)') }}>{getCountdown(session.start, nowInNY)}</div>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* Clock strip */}
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 py-3 flex flex-wrap gap-x-4 gap-y-2 items-center">
          <div className="flex items-center gap-2">
            <span className="text-[7px] font-black tracking-[0.25em] uppercase text-white/20">UTC</span>
            <span className="font-mono text-[11px] font-bold text-white/50 tabular-nums">{timeStr}</span>
            <span className="text-[7px] text-white/15 hidden sm:inline">{dateStr}</span>
          </div>
          <div className="w-px h-3 bg-white/[0.08] hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-[7px] font-black tracking-[0.25em] uppercase text-[#F27D26]/50">NY</span>
            <span className="font-mono text-[11px] font-bold text-white/40 tabular-nums">{formatInTimeZone(now, 'America/New_York', 'HH:mm:ss')}</span>
          </div>
          <div className="w-px h-3 bg-white/[0.08] hidden sm:block" />
          <div className="flex items-center gap-2">
            <Clock size={9} className="text-[#8B5CF6]/50" />
            <button
              onClick={() => { setTzSearch(''); setShowTzPicker(true); }}
              className="flex items-center gap-1 text-[7px] font-black uppercase tracking-[0.25em] text-[#8B5CF6]/60 hover:text-[#8B5CF6] transition-colors">
              {tzDisplayName}
              <ChevronDown size={7} className="text-white/20" />
            </button>
            <span className="font-mono text-[11px] font-bold text-white/40 tabular-nums">{formatInTimeZone(now, localTimeZone, 'HH:mm:ss')}</span>
          </div>
        </div>

        <div className="flex items-start gap-2 px-1">
          <AlertCircle size={10} className="text-white/15 mt-0.5 shrink-0" />
          <p className="text-[9px] text-white/15 leading-relaxed">
            All session times reference UTC. Trading hours may vary by broker.
            {isNative && <span className="italic"> Running natively on Android.</span>}
          </p>
        </div>

        {/* Signature */}
        <div className="flex justify-end px-1 pt-1">
          <span className="text-[8px] font-black tracking-[0.2em] uppercase text-white/10 select-none">
            Bzoefx <span className="text-[#F27D26]/30">v.1</span>
          </span>
        </div>
      </div>

      {/* ── Feature Panel (slide-up) ─────────────────────────────── */}
      <FeaturePanel
        open={showPanel} onClose={() => setShowPanel(false)} isNative={isNative} isDark={isDark}
        alertsEnabled={alertsEnabled} setAlertsEnabled={setAlertsEnabled}
        notifGranted={notifGranted}
        reminderMode={reminderMode} setReminderMode={setReminderMode}
        sessionRingtoneName={sessionRingtoneName} setSessionRingtoneName={setSessionRingtoneName}
        reminderRingtoneName={reminderRingtoneName} setReminderRingtoneName={setReminderRingtoneName}
        webSessionRingtoneId={webSessionRingtoneId} setWebSessionRingtoneId={setWebSessionRingtoneId}
        webReminderRingtoneId={webReminderRingtoneId} setWebReminderRingtoneId={setWebReminderRingtoneId}
        batteryOptOff={batteryOptOff} setBatteryOptOff={setBatteryOptOff}
        canExactAlarm={canExactAlarm} setCanExactAlarm={setCanExactAlarm}
        requestPermission={requestPermission}
        sendNotification={sendNotification}
        sendReminderNotification={sendReminderNotification}
        playAlertSound={playAlertSound}
        playReminderSound={playReminderSound}
        fundamentals={fundamentals}
        fundamentalsLoading={fundamentalsLoading}
        fundamentalsError={fundamentalsError}
        onRefreshFundamentals={() => fetchFundamentals()}
        onTriggerMake={triggerMakeAndRefresh}
        makeTriggered={makeTriggered}
        ringerMode={ringerMode}
      />

      {/* ── Timezone Picker ──────────────────────────────────────── */}
      <AnimatePresence>
        {showTzPicker && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => setShowTzPicker(false)}>
            <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 40 }} transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
              className="w-full max-w-sm h-[75vh] rounded-t-3xl sm:rounded-2xl border border-white/[0.08] bg-[var(--bg-panel)] shadow-2xl flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/[0.05]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#8B5CF6]/10 border border-[#8B5CF6]/20 flex items-center justify-center">
                    <Clock size={14} className="text-[#8B5CF6]" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold">Time Zone</h3>
                    <p className="text-[9px] text-white/25 mt-0.5">Search any city or region</p>
                  </div>
                </div>
                <button onClick={() => setShowTzPicker(false)}
                  className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center text-white/30 hover:text-white/70 transition-colors">
                  <X size={13} />
                </button>
              </div>

              {/* Search */}
              <div className="px-4 py-3 border-b border-white/[0.05]">
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.07]">
                  <Search size={12} className="text-white/30 shrink-0" />
                  <input
                    autoFocus
                    value={tzSearch}
                    onChange={e => setTzSearch(e.target.value)}
                    placeholder="Search city or timezone…"
                    className="flex-1 bg-transparent text-[11px] text-white placeholder-white/20 focus:outline-none"
                  />
                  {tzSearch && (
                    <button onClick={() => setTzSearch('')} className="text-white/30 hover:text-white/60 transition-colors">
                      <X size={10} />
                    </button>
                  )}
                </div>
              </div>

              {/* Timezone list */}
              <div className="flex-1 overflow-y-auto py-1">
                {/* Local shortcut — only shown when not searching */}
                {!tzSearch && (
                  <button
                    onClick={() => { setLocalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone); setShowTzPicker(false); }}
                    className={`w-full flex items-center justify-between px-5 py-3 hover:bg-white/[0.04] transition-colors ${localTimeZone === Intl.DateTimeFormat().resolvedOptions().timeZone ? 'text-[#8B5CF6]' : 'text-white/60'}`}>
                    <div>
                      <div className="text-[11px] font-bold">Local (device default)</div>
                      <div className="text-[9px] text-white/30 mt-0.5">{Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
                    </div>
                    {localTimeZone === Intl.DateTimeFormat().resolvedOptions().timeZone && <CheckCircle2 size={13} className="text-[#8B5CF6]" />}
                  </button>
                )}

                {filteredTimezones.map(tz => (
                  <button key={tz}
                    onClick={() => { setLocalTimeZone(tz); setShowTzPicker(false); }}
                    className={`w-full flex items-center justify-between px-5 py-2.5 hover:bg-white/[0.04] transition-colors ${localTimeZone === tz ? 'text-[#8B5CF6]' : 'text-white/60'}`}>
                    <div>
                      <div className="text-[11px] font-semibold">{tz.split('/').pop()?.replace(/_/g, ' ')}</div>
                      <div className="text-[9px] text-white/25 mt-0.5">{tz}</div>
                    </div>
                    {localTimeZone === tz && <CheckCircle2 size={13} className="text-[#8B5CF6]" />}
                  </button>
                ))}

                {filteredTimezones.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-white/20">
                    <Clock size={24} className="mb-3" />
                    <p className="text-[11px]">No timezones match "{tzSearch}"</p>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Dev Panel ────────────────────────────────────────────── */}
      <AnimatePresence>
        {showDevPanel && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
            onClick={() => setShowDevPanel(false)}>
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }} transition={{ type: 'spring', bounce: 0.25, duration: 0.4 }}
              className="w-full max-w-sm rounded-2xl border border-orange-500/20 bg-[var(--bg-panel)] shadow-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/[0.05]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center"><Zap size={14} className="text-orange-400" /></div>
                  <div><h3 className="text-sm font-bold">Dev Panel</h3><p className="text-[9px] text-white/25 mt-0.5">Long-press logo</p></div>
                </div>
                <button onClick={() => setShowDevPanel(false)} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center text-white/30 hover:text-white/70 transition-colors"><X size={13} /></button>
              </div>
              <div className="px-5 py-4 space-y-2">
                <button onClick={async () => { await sendNotification('TEST: London Open', 'London session now active.'); toast.success('Test notification sent'); }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-500/[0.06] border border-blue-500/20 hover:bg-blue-500/[0.12] transition-all">
                  <div className="w-7 h-7 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0"><Bell size={13} className="text-blue-400" /></div>
                  <div className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Fire Test Notification</div>
                </button>
                <button onClick={async () => { await sendReminderNotification(); }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-purple-500/[0.06] border border-purple-500/20 hover:bg-purple-500/[0.12] transition-all">
                  <div className="w-7 h-7 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0"><Timer size={13} className="text-purple-400" /></div>
                  <div className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">Fire 15m Reminder</div>
                </button>
                {isNative && (
                  <button onClick={() => { Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {}); toast.info('Haptic triggered.'); }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all">
                    <div className="w-7 h-7 rounded-lg bg-white/[0.06] flex items-center justify-center shrink-0"><Activity size={13} className="text-white/40" /></div>
                    <div className="text-[10px] font-bold text-white/50 uppercase tracking-wider">Test Vibration</div>
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Onboarding (first launch) ─────────────────────────── */}
      <AnimatePresence>
        {showOnboarding && (
          <Onboarding
            isNative={isNative}
            isDark={isDark}
            onComplete={() => {
              try { localStorage.setItem('onboardingDone', '1'); } catch {}
              setShowOnboarding(false);
            }}
            onRequestPermission={requestPermission}
            onRequestExactAlarm={openExactAlarmSettings}
            onRequestBattery={requestBatteryOpt}
          />
        )}
      </AnimatePresence>

      <Toaster
        theme={isDark ? 'dark' : 'light'} position="top-right"
        toastOptions={{ style: { background: 'var(--bg-panel)', border: `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.10)'}`, color: 'var(--text-base)', fontFamily: '"Space Grotesk", sans-serif', fontSize: '13px' } }}
      />
    </div>
  );
}
