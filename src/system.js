import { col } from './db.js';

const QUEST_LABEL = {
  hydrate: 'Hydrate (2L)',
  read: 'Read / reflect',
  build: 'Ship one thing',
};

// ---------------- pure logic (no DB, unit-testable) ----------------

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// A 10-cell progress bar: ▰ filled, ▱ empty.
function bar(value, max, width = 10) {
  const fill = clamp(max > 0 ? Math.round((value / max) * width) : width, 0, width);
  return '▰'.repeat(fill) + '▱'.repeat(width - fill);
}

// Energy is derived from reality, never stored: last night's sleep is the
// foundation (up to 70), today's water tops it up (up to 30). Range 0–100.
// e.g. 7h + 2L ≈ 86; 5h + a dry morning ≈ 28.
export function energyFrom({ sleepHours, waterLitres }) {
  const h = Number(sleepHours);
  const sleepPart =
    sleepHours == null || Number.isNaN(h)
      ? 45 // neutral assumption when we don't know last night
      : clamp(Math.round(((h - 3) / 5) * 70), 0, 70);
  const waterPart = clamp(Math.round(((Number(waterLitres) || 0) / 2) * 30), 0, 30);
  return clamp(sleepPart + waterPart, 0, 100);
}

// Status effects derived from recent reality — honest mirrors of how the body
// is actually doing, not punishments. Debuffs have teeth (cap energy, shave XP
// gain); buffs reward good days. Gaming is handled by the coach in conversation,
// never here.
export function effectsFrom({ sleepHours, todayWater, yesterdayWater }) {
  const debuffs = [];
  const buffs = [];
  const h = Number(sleepHours);
  const knownSleep = sleepHours != null && !Number.isNaN(h);

  if (knownSleep && h < 6) {
    debuffs.push({ key: 'sleep_debt', label: `SLEEP-DEBT · ${h}h`, note: 'foggy focus, low drive', xpMult: 0.8, energyCap: 100 });
  }
  if ((Number(yesterdayWater) || 0) < 1 && (Number(todayWater) || 0) < 1) {
    debuffs.push({ key: 'dehydrated', label: 'DEHYDRATED · 2 dry days', note: 'headache risk, flat afternoon', xpMult: 1, energyCap: 60 });
  }
  if (knownSleep && h >= 8) {
    buffs.push({ key: 'well_rested', label: `WELL-RESTED · ${h}h`, note: 'sharp — +10% XP', xpMult: 1.1 });
  }
  return { debuffs, buffs };
}

// Net XP multiplier from all active effects.
export function xpMultiplier({ debuffs = [], buffs = [] } = {}) {
  return [...debuffs, ...buffs].reduce((m, e) => m * (e.xpMult ?? 1), 1);
}

// Lowest energy ceiling imposed by active debuffs.
export function energyCap({ debuffs = [] } = {}) {
  return debuffs.reduce((cap, d) => Math.min(cap, d.energyCap ?? 100), 100);
}

// Per-level XP cost accelerates hard: gentle at first, a real grind up high.
// L1→2 ≈ 110, L5→6 ≈ 450, L10→11 ≈ 1325, L20→21 ≈ 4575.
export function levelStep(l) {
  return 75 + 25 * l + 10 * l * l;
}

// Cumulative XP required to BE at a given level (level 1 = 0 XP).
export function xpToReach(level) {
  let total = 0;
  for (let l = 1; l < level; l++) total += levelStep(l);
  return total;
}

export function levelForXp(xp) {
  let level = 1;
  while (xp >= xpToReach(level + 1)) level++;
  return level;
}

// XP awards for a coach action → list of [stat, xp].
export function awardsFor(action) {
  switch (action.type) {
    case 'log_water':
      return [['vitality', Math.max(4, Math.round((Number(action.litres) || 0.5) * 10))]];
    case 'log_sleep': {
      const h = Number(action.hours);
      const xp = !h ? 10 : h >= 7 ? 20 : h >= 6 ? 12 : 5;
      return [['vitality', xp]];
    }
    case 'set_reading':
      return [['mind', 10]];
    case 'log_progress':
      return [['mind', 12]];
    case 'finish_book':
      return [['mind', 60]];
    case 'log_essay':
      return [['mind', 30]];
    case 'log_work':
      return [['forge', 20]];
    case 'log_note':
      return [['mind', 2]];
    default:
      return [];
  }
}

// Given today's logs, which quests are satisfied right now.
export function questsFromLogs(logs) {
  const water = logs.filter((l) => l.type === 'water').reduce((s, l) => s + (l.value || 0), 0);
  return {
    hydrate: water >= 2,
    read: logs.some((l) => l.type === 'book' || l.type === 'essay'),
    build: logs.some((l) => l.type === 'work'),
  };
}

export function titleForLevel(l) {
  if (l >= 20) return 'The Disciplined';
  if (l >= 10) return 'The Builder';
  if (l >= 5) return 'Initiate';
  return null;
}

export function renderStatus(s, energy = null, effects = null) {
  const floor = xpToReach(s.level);
  const next = xpToReach(s.level + 1);
  const prog = s.xp - floor;
  const need = next - floor;
  const q = s.quests || {};
  const line = (k) => ` ${q[k] ? '✓' : '▢'} ${QUEST_LABEL[k]}`;

  const out = [
    '⟦  S T A T U S  ⟧',
    `LEVEL ${s.level}`,
    `XP     ${bar(prog, need)}  ${prog}/${need}`,
  ];
  if (energy != null) out.push(`ENERGY ${bar(energy, 100)}  ${energy}/100`);
  out.push(
    '',
    `VITALITY   ${s.stats.vitality}`,
    `MIND       ${s.stats.mind}`,
    `FORGE      ${s.stats.forge}`,
    `DISCIPLINE ${s.stats.discipline}`,
    '',
    `STREAK  🔥 ${s.streak} days`,
    '',
    'DAILY QUESTS',
    line('hydrate'),
    line('read'),
    line('build')
  );
  const eff = effects || {};
  if (eff.debuffs && eff.debuffs.length) {
    out.push('', 'DEBUFFS');
    for (const d of eff.debuffs) out.push(` ⚠ ${d.label}${d.note ? ' — ' + d.note : ''}`);
  }
  if (eff.buffs && eff.buffs.length) {
    out.push('', 'BUFFS');
    for (const b of eff.buffs) out.push(` ✦ ${b.label}${b.note ? ' — ' + b.note : ''}`);
  }
  if (s.titles && s.titles.length) out.push('', `TITLES: ${s.titles.join(', ')}`);
  return out.join('\n');
}

// ---------------- DB-backed state ----------------

function freshState() {
  return {
    _id: 'state',
    level: 1,
    xp: 0,
    stats: { vitality: 0, mind: 0, forge: 0, discipline: 0 },
    streak: 0,
    questDate: null,
    quests: {},
    lastClearDate: null,
    titles: [],
  };
}

async function getState() {
  let s = await col('system').findOne({ _id: 'state' });
  if (!s) {
    s = freshState();
    await col('system').insertOne(s);
  }
  return s;
}

async function saveState(s) {
  await col('system').updateOne({ _id: 'state' }, { $set: s }, { upsert: true });
}

async function todaysLogs() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return col('logs').find({ ts: { $gte: start } }).toArray();
}

// Reset the quest board if it's a new day.
function rollDay(s) {
  const today = new Date().toISOString().slice(0, 10);
  if (s.questDate !== today) {
    s.questDate = today;
    s.quests = {};
  }
}

// Process one logged action: award XP, update quests/streak, detect level-ups.
// Returns an array of System "ping" lines to show the user (may be empty).
export async function recordAction(action) {
  const s = await getState();
  const prevLevel = s.level;
  const pings = [];

  // Active effects scale the action's XP (debuffs shave it, buffs boost it).
  const mult = xpMultiplier((await energySnapshot()).effects);
  for (const [stat, xp] of awardsFor(action)) {
    const gain = Math.round(xp * mult);
    s.stats[stat] = (s.stats[stat] || 0) + gain;
    s.xp += gain;
  }

  // Quests
  rollDay(s);
  const now = questsFromLogs(await todaysLogs());
  for (const k of ['hydrate', 'read', 'build']) {
    if (now[k] && !s.quests[k]) {
      s.quests[k] = true;
      s.stats.discipline += 15;
      s.xp += 15;
      pings.push(`⟦ DAILY QUEST ⟧ ${QUEST_LABEL[k]} — complete.  DISCIPLINE +15`);
    }
  }
  const allDone = ['hydrate', 'read', 'build'].every((k) => s.quests[k]);
  if (allDone && s.lastClearDate !== s.questDate) {
    s.lastClearDate = s.questDate;
    s.streak = (s.streak || 0) + 1;
    s.stats.discipline += 25;
    s.xp += 25;
    pings.push(`⟦ ALL QUESTS CLEARED ⟧ Streak: ${s.streak} 🔥  DISCIPLINE +25`);
  }

  // Level-up
  const newLevel = levelForXp(s.xp);
  if (newLevel > prevLevel) {
    s.level = newLevel;
    pings.push(`⟦ LEVEL UP ⟧ Lv.${prevLevel} → Lv.${newLevel}`);
    const title = titleForLevel(newLevel);
    if (title && !s.titles.includes(title)) {
      s.titles.push(title);
      pings.push(`⟦ TITLE EARNED ⟧ "${title}"`);
    }
  }

  await saveState(s);
  return pings;
}

// ---------------- energy (derived from the log stream) ----------------

function dayRange(offsetDays = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function waterBetween(start, end) {
  const rows = await col('logs').find({ type: 'water', ts: { $gte: start, $lt: end } }).toArray();
  return rows.reduce((sum, l) => sum + (l.value || 0), 0);
}

async function lastSleepHours() {
  const since = new Date(Date.now() - 18 * 60 * 60 * 1000); // "last night"
  const s = await col('logs').findOne({ type: 'sleep', ts: { $gte: since } }, { sort: { ts: -1 } });
  return s && s.hours != null ? Number(s.hours) : null;
}

// Current energy plus the raw inputs, so the coach can speak to consequences.
export async function energySnapshot() {
  const today = dayRange(0);
  const yest = dayRange(1);
  const [sleepHours, todayWater, yesterdayWater] = await Promise.all([
    lastSleepHours(),
    waterBetween(today.start, today.end),
    waterBetween(yest.start, yest.end),
  ]);
  const effects = effectsFrom({ sleepHours, todayWater, yesterdayWater });
  const base = energyFrom({ sleepHours, waterLitres: todayWater });
  return {
    energy: Math.min(base, energyCap(effects)),
    sleepHours,
    todayWater,
    yesterdayWater,
    effects,
  };
}

// Render the status window (refreshes today's quest state for display).
export async function statusWindow() {
  const s = await getState();
  rollDay(s);
  const now = questsFromLogs(await todaysLogs());
  s.quests = { ...s.quests, ...Object.fromEntries(Object.entries(now).filter(([, v]) => v)) };
  await saveState(s);
  const { energy, effects } = await energySnapshot();
  return renderStatus(s, energy, effects);
}
