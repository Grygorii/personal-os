import { col } from './db.js';

const QUEST_LABEL = {
  hydrate: 'Hydrate (2L)',
  move: 'Move (train your body)',
  read: 'Read / reflect',
  build: 'Ship one thing',
};
const QUEST_KEYS = ['hydrate', 'move', 'read', 'build'];

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
export function effectsFrom({ sleepHours, todayWater, yesterdayWater, moveForm, mindForm }) {
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

  // Detraining: stop feeding a domain and your CONDITION there slips (research-backed).
  // The debuff appears as form falls, deepens the longer you're away, and fades only
  // after several sessions back — the body and mind rebuild slowly, just like real life.
  const body = detrainingDebuff('body', moveForm, 'strength & stamina fading — the first sessions back feel harder than you remember');
  if (body) debuffs.push(body);
  const mind = detrainingDebuff('mind', mindForm, 'recall slower and focus foggier without regular reading — it sharpens back within days');
  if (mind) debuffs.push(mind);

  if (knownSleep && h >= 8) {
    buffs.push({ key: 'well_rested', label: `WELL-RESTED · ${h}h`, note: 'sharp — +10% XP', xpMult: 1.1 });
  }
  return { debuffs, buffs };
}

// A detraining debuff from a 0–100 condition score (null = not enough history to judge).
// Deepens as condition drops; clears only once it climbs back above the threshold.
function detrainingDebuff(domain, form, note) {
  if (form == null || form >= 60) return null;
  const [tag, xpMult] = form < 25 ? ['heavy', 0.7] : form < 40 ? ['moderate', 0.82] : ['mild', 0.92];
  const name = domain === 'body' ? 'DETRAINING' : 'DULL EDGE';
  return { key: `detrain_${domain}`, label: `${name} · ${domain} (${tag})`, note, xpMult, energyCap: 100 };
}

// --- condition: research-shaped detraining + recovery ----------------------------
// Fitness loss begins ~day 10 of no training; cardio falls ~6% by 4 weeks and ~20% by
// ~11 weeks, while strength is retained far longer (muscle memory). Recovery scales with
// how deep you fell: a couple weeks off is regained in a couple weeks; months off take
// ~3 months. So: a grace period, then decline toward a muscle-memory floor; rebuilding
// from a deep hole takes many more sessions than topping back up from a shallow dip.
const CONDITION = { graceDays: 7, halfLifeDays: 30, floorFactor: 0.12, initForm: 70, baseGain: 8 };

// Decay a stored condition over idle days (grace, then exponential decline to a floor).
export function decayCondition(v, peak, idleDays) {
  const eff = Math.max(0, idleDays - CONDITION.graceDays);
  const decayed = v * Math.pow(0.5, eff / CONDITION.halfLifeDays);
  const floor = (peak || 0) * CONDITION.floorFactor; // muscle memory: never fully lost
  return clamp(Math.round(Math.max(decayed, floor)), 0, 100);
}

// One session's gain — larger if you've been higher before (muscle memory: you regain
// faster than you first built). Deep detraining still takes many sessions to climb out.
export function recoveryGain(peak) {
  return Math.round(CONDITION.baseGain * (0.7 + 0.6 * ((peak || 0) / 100)));
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
    case 'log_movement':
      return [['vitality', 18]];
    case 'log_meal':
      return [['vitality', 6]];
    case 'log_mood':
      return [['spirit', 5]];
    case 'log_social':
      return [['spirit', 15]];
    case 'log_reflect':
      return [['spirit', 12]];
    case 'log_restraint':
      return [['discipline', 12]];
    case 'log_pursuit':
      return [['discipline', 10]];
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
    move: logs.some((l) => l.type === 'move'),
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

// ---------------- ranks (a universal mastery ladder over uncapped levels) ----------------
// The level number climbs forever — there is no cap, no "winning". Ranks give the
// climb texture and a near horizon; Sage (Lv.100+) is the title almost no one reaches.
// Names are deliberately universal and timeless (not game-y) so they fit anyone of any
// age, profession, or background. The only end is the one you can't code around.
const RANKS = [
  { min: 1, title: 'Novice' },
  { min: 5, title: 'Apprentice' },
  { min: 10, title: 'Adept' },
  { min: 20, title: 'Expert' },
  { min: 35, title: 'Master' },
  { min: 55, title: 'Grandmaster' },
  { min: 80, title: 'Luminary' },
  { min: 100, title: 'Sage' },
];

export function rankForLevel(level) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (level >= r.min) rank = r;
    else break;
  }
  return rank;
}

export function nextRankAfter(level) {
  return RANKS.find((r) => r.min > level) || null;
}

export function renderLadder(currentLevel = 0) {
  const lines = ['⟦  R A N K   L A D D E R  ⟧'];
  RANKS.forEach((r, i) => {
    const next = RANKS[i + 1];
    const range = next ? `Lv.${r.min}-${next.min - 1}` : `Lv.${r.min}+`;
    const here = currentLevel >= r.min && (!next || currentLevel < next.min);
    lines.push(`${here ? '►' : ' '} ${r.title.padEnd(22)} ${range}`);
  });
  lines.push('', 'No ceiling above Sage — the climb never ends.');
  return lines.join('\n');
}

// Per-domain rank: a stat's VALUE mapped onto the same ladder, so someone can be a Master
// of the Body and a Novice of the Mind — rank reflects what he actually pours himself into.
const STAT_RANK_MINS = [0, 150, 400, 900, 1800, 3200, 5500, 9000];
const DOMAIN_NOUN = { vitality: 'Body', mind: 'Mind', forge: 'Craft', discipline: 'Discipline', spirit: 'Spirit' };

export function rankForStat(value) {
  let i = 0;
  for (let k = 0; k < STAT_RANK_MINS.length; k++) {
    if ((value || 0) >= STAT_RANK_MINS[k]) i = k;
    else break;
  }
  return RANKS[i].title;
}

export function renderStatus(s, energy = null, effects = null) {
  const floor = xpToReach(s.level);
  const next = xpToReach(s.level + 1);
  const prog = s.xp - floor;
  const need = next - floor;
  const q = s.quests || {};
  const line = (k) => ` ${q[k] ? '✓' : '▢'} ${QUEST_LABEL[k]}`;

  const rank = rankForLevel(s.level);
  const upcoming = nextRankAfter(s.level);
  const out = [
    '⟦  S T A T U S  ⟧',
    `LEVEL ${s.level} · ${rank.title}`,
  ];
  if (upcoming) out.push(`  → ${upcoming.title} at Lv.${upcoming.min}`);
  out.push(`XP     ${bar(prog, need)}  ${prog}/${need}`);
  if (energy != null) out.push(`ENERGY ${bar(energy, 100)}  ${energy}/100`);
  out.push(
    '',
    `VITALITY   ${String(s.stats.vitality || 0).padEnd(6)}${rankForStat(s.stats.vitality)}`,
    `MIND       ${String(s.stats.mind || 0).padEnd(6)}${rankForStat(s.stats.mind)}`,
    `FORGE      ${String(s.stats.forge || 0).padEnd(6)}${rankForStat(s.stats.forge)}`,
    `DISCIPLINE ${String(s.stats.discipline || 0).padEnd(6)}${rankForStat(s.stats.discipline)}`,
    `SPIRIT     ${String(s.stats.spirit || 0).padEnd(6)}${rankForStat(s.stats.spirit)}`,
    '',
    `STREAK  🔥 ${s.streak} days`,
    '',
    'DAILY QUESTS',
    ...QUEST_KEYS.map(line)
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
    stats: { vitality: 0, mind: 0, forge: 0, discipline: 0, spirit: 0 },
    streak: 0,
    questDate: null,
    quests: {},
    lastClearDate: null,
    titles: [],
    condition: {},
  };
}

async function getState() {
  let s = await col('system').findOne({ _id: 'state' });
  if (!s) {
    s = freshState();
    await col('system').insertOne(s);
  }
  // Ensure every stat exists, even on states seeded before a stat was added.
  s.stats = { vitality: 0, mind: 0, forge: 0, discipline: 0, spirit: 0, ...s.stats };
  s.condition = s.condition || {};
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
  const prevStats = { ...s.stats };
  const pings = [];

  // Active effects scale the action's XP (debuffs shave it, buffs boost it).
  const mult = xpMultiplier((await energySnapshot()).effects);
  for (const [stat, xp] of awardsFor(action)) {
    const gain = Math.round(xp * mult);
    s.stats[stat] = (s.stats[stat] || 0) + gain;
    s.xp += gain;
  }

  // Training a domain rebuilds its condition (recovers detraining over sessions).
  const trained = DOMAIN_BY_ACTION[action.type];
  if (trained) bumpCondition(s, trained);

  // Quests
  rollDay(s);
  const now = questsFromLogs(await todaysLogs());
  for (const k of QUEST_KEYS) {
    if (now[k] && !s.quests[k]) {
      s.quests[k] = true;
      s.stats.discipline += 15;
      s.xp += 15;
      pings.push(`⟦ DAILY QUEST ⟧ ${QUEST_LABEL[k]} — complete.  DISCIPLINE +15`);
    }
  }
  const allDone = QUEST_KEYS.every((k) => s.quests[k]);
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
    if (rankForLevel(newLevel).title !== rankForLevel(prevLevel).title) {
      pings.push(`⟦ RANK UP ⟧ You are now ${rankForLevel(newLevel).title}.`);
    }
    const title = titleForLevel(newLevel);
    if (title && !s.titles.includes(title)) {
      s.titles.push(title);
      pings.push(`⟦ TITLE EARNED ⟧ "${title}"`);
    }
  }

  // Per-domain rank-ups — a stat crossing a mastery threshold ("Master of the Body").
  for (const stat of Object.keys(s.stats)) {
    const after = rankForStat(s.stats[stat]);
    if (after !== rankForStat(prevStats[stat] || 0)) {
      const noun = DOMAIN_NOUN[stat] || stat;
      pings.push(`⟦ ${noun.toUpperCase()} RANK UP ⟧ ${after} of ${noun}`);
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

// Which domain a coach action trains (so we can update its condition).
const DOMAIN_BY_ACTION = {
  log_movement: 'body',
  set_reading: 'mind',
  log_progress: 'mind',
  finish_book: 'mind',
  log_essay: 'mind',
};

// Current decayed condition for a domain (null if he's never trained it — no debuff then).
function currentCondition(s, domain) {
  const c = s.condition && s.condition[domain];
  if (!c) return null;
  const idleDays = (Date.now() - new Date(c.ts).getTime()) / (24 * 60 * 60 * 1000);
  return decayCondition(c.v, c.peak, idleDays);
}

// Apply one session: decay to now, then add the recovery gain; track peak (muscle memory).
function bumpCondition(s, domain) {
  s.condition = s.condition || {};
  const c = s.condition[domain];
  const now = new Date();
  if (!c) {
    // First session in a domain: he's clearly active now — start in decent form.
    s.condition[domain] = { v: CONDITION.initForm, peak: CONDITION.initForm, ts: now };
    return;
  }
  const idleDays = (now.getTime() - new Date(c.ts).getTime()) / (24 * 60 * 60 * 1000);
  const v = clamp(decayCondition(c.v, c.peak, idleDays) + recoveryGain(c.peak), 0, 100);
  s.condition[domain] = { v, peak: Math.max(c.peak || 0, v), ts: now };
}

// Current energy plus the raw inputs, so the coach can speak to consequences.
export async function energySnapshot() {
  const today = dayRange(0);
  const yest = dayRange(1);
  const [s, sleepHours, todayWater, yesterdayWater] = await Promise.all([
    getState(),
    lastSleepHours(),
    waterBetween(today.start, today.end),
    waterBetween(yest.start, yest.end),
  ]);
  const effects = effectsFrom({
    sleepHours,
    todayWater,
    yesterdayWater,
    moveForm: currentCondition(s, 'body'),
    mindForm: currentCondition(s, 'mind'),
  });
  const base = energyFrom({ sleepHours, waterLitres: todayWater });
  return { energy: Math.min(base, energyCap(effects)), sleepHours, todayWater, yesterdayWater, effects };
}

// Raw System state for the coach to reference the climb (no rendering).
export async function currentState() {
  const s = await getState();
  return {
    level: s.level,
    xp: s.xp,
    stats: s.stats,
    streak: s.streak,
    titles: s.titles || [],
    rank: rankForLevel(s.level).title,
    domainRanks: {
      vitality: rankForStat(s.stats.vitality),
      mind: rankForStat(s.stats.mind),
      forge: rankForStat(s.stats.forge),
      discipline: rankForStat(s.stats.discipline),
      spirit: rankForStat(s.stats.spirit),
    },
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
