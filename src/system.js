import { col } from './db.js';
import { config } from './config.js';

const QUEST_LABEL = {
  hydrate: 'Hydrate',
  move: 'Move',
  read: 'Sharpen mind',
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

// --- condition: detraining + recovery, gated by how deeply INGRAINED a skill is --------
// Research: fitness loss begins ~day 10; cardio falls ~6% by 4wk, ~20% by ~11wk; strength
// (muscle memory) lasts far longer. But retention really depends on DEPTH of practice:
//  • a few months of casual Spanish → low mastery → you forget almost all of it;
//  • five years of driving → high mastery → you keep it through long breaks (mild rust);
//  • ten years on an instrument → a year off leaves you good, just below your peak.
// "mastery" (0–100) grows slowly with sustained practice (months/years), barely fades, and
// sets BOTH the retention floor and how slowly form decays. Deeper = far stickier.
const DAY = 24 * 60 * 60 * 1000;
const CONDITION = { graceDays: 7, baseHalfLifeDays: 30, masteryHalfLife: 35, masteryRate: 0.0015, initForm: 70, baseGain: 8 };

// Decay current form (v) over idle days toward the mastery floor; deeper mastery decays slower.
export function decayCondition(v, mastery, idleDays) {
  const m = mastery || 0;
  const eff = Math.max(0, idleDays - CONDITION.graceDays);
  const halfLife = CONDITION.baseHalfLifeDays * Math.exp(m / CONDITION.masteryHalfLife);
  const decayed = v * Math.pow(0.5, eff / halfLife);
  return clamp(Math.round(Math.max(decayed, m)), 0, 100); // never drop below what's ingrained
}

// Mastery one more session ingrains — diminishing, so real depth takes months/years.
export function masteryAfterSession(mastery) {
  const m = mastery || 0;
  return m + (100 - m) * CONDITION.masteryRate;
}

// Per-session form gain — faster when more is ingrained (muscle memory regains quickly).
export function recoveryGain(mastery) {
  return Math.round(CONDITION.baseGain * (0.7 + 0.6 * ((mastery || 0) / 100)));
}

// Net XP multiplier from all active effects.
export function xpMultiplier({ debuffs = [], buffs = [] } = {}) {
  return [...debuffs, ...buffs].reduce((m, e) => m * (e.xpMult ?? 1), 1);
}

// Lowest energy ceiling imposed by active debuffs.
export function energyCap({ debuffs = [] } = {}) {
  return debuffs.reduce((cap, d) => Math.min(cap, d.energyCap ?? 100), 100);
}

// Reward a balanced "wheel of life": XP into an already-dominant stat is dampened while
// neglected stats earn full XP — so grinding one easy thing yields less and less, and
// roundedness pays. Floor 0.4 so a strong area still grows, just slower.
export function balanceMultiplier(statValue, allStats) {
  const vals = Object.values(allStats || {});
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  if (avg <= 0) return 1;
  const ratio = (statValue || 0) / avg;
  return ratio <= 1 ? 1 : clamp(1 / ratio, 0.4, 1);
}

// Energy drains through the waking day — it can't sit at 90% at bedtime. ~0 just after
// waking (7am reference), deepening toward night; wraps so late nights read as drained too.
export function dayDrain(hour) {
  const awake = hour >= 7 ? hour - 7 : hour + 17;
  return Math.round(clamp(awake, 0, 16) * 2.5);
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
      return [['mind', 6]];
    case 'log_progress':
      return [['mind', 4]]; // turning pages alone is barely growth — real thinking earns mind
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
    case 'log_study': {
      // Mind grows with the DEPTH of his thinking, not the act — the coach evaluates and scales.
      const xp = action.depth === 'deep' ? 28 : action.depth === 'light' ? 5 : 14;
      return [['mind', xp]];
    }
    case 'log_exam': {
      // A graded book exam — honest proof of understanding. XP follows the real score.
      const s = Number(action.score) || 0;
      return [['mind', s >= 80 ? 35 : s >= 60 ? 22 : s >= 40 ? 12 : 6]];
    }
    case 'log_english': {
      // Honest: a weak exchange barely moves Mind; a sharp, deep one earns real ground.
      // The five 1–5 scores average into XP, floored at 0 — the Mind stat never goes negative,
      // so decline shows honestly in /englishreport and via detraining when he stops, not as a
      // corrupted stat. A poor conversation is worth almost nothing, which is the truth.
      const sc = action.scores || {};
      const vals = ['clarity', 'grammar', 'vocab', 'concise', 'register']
        .map((k) => Number(sc[k]))
        .filter((n) => !Number.isNaN(n));
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 3;
      const base = Math.round((avg - 2) * 8); // avg 2→0, 3→8, 4→16, 5→24
      const bonus = base > 0 ? (action.depth === 'deep' ? 8 : action.depth === 'light' ? 0 : 4) : 0;
      return [['mind', Math.max(0, base + bonus)]];
    }
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
    read: logs.some((l) => l.type === 'book' || l.type === 'essay' || l.type === 'study' || l.type === 'english' || l.type === 'exam'),
    build: logs.some((l) => l.type === 'work'),
  };
}

// Display progress toward each daily quest's target (current/target) for /status.
export function questProgress(logs) {
  const r1 = (n) => Math.round(n * 10) / 10;
  const water = logs.filter((l) => l.type === 'water').reduce((s, l) => s + (l.value || 0), 0);
  const count = (types) => logs.filter((l) => types.includes(l.type)).length;
  const mk = (met, text) => ({ met, text });
  const moveN = count(['move']);
  const readN = count(['book', 'essay', 'study', 'english']);
  const buildN = count(['work']);
  return {
    hydrate: mk(water >= 2, `${r1(water)}/2L`),
    move: mk(moveN >= 1, `${Math.min(moveN, 1)}/1`),
    read: mk(readN >= 1, `${Math.min(readN, 1)}/1`),
    build: mk(buildN >= 1, `${Math.min(buildN, 1)}/1`),
  };
}

// Which life-domain (stat) each log type feeds — used for breadth/balance.
const TYPE_DOMAIN = {
  water: 'body', sleep: 'body', meal: 'body', move: 'body',
  book: 'mind', essay: 'mind', study: 'mind', note: 'mind', english: 'mind', exam: 'mind',
  work: 'forge',
  mood: 'spirit', social: 'spirit', reflect: 'spirit',
  restraint: 'discipline',
};
function domainsToday(logs) {
  return new Set(logs.map((l) => TYPE_DOMAIN[l.type]).filter(Boolean));
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

export function renderStatus(s, energy = null, effects = null, progress = null, nowText = null) {
  const floor = xpToReach(s.level);
  const next = xpToReach(s.level + 1);
  const prog = s.xp - floor;
  const need = next - floor;
  const q = s.quests || {};
  const line = (k) => {
    const p = progress && progress[k];
    const met = p ? p.met : q[k];
    const amount = p ? `  ${p.text}` : '';
    return ` ${met ? '✓' : '▢'} ${QUEST_LABEL[k].padEnd(14)}${amount}`;
  };

  const rank = rankForLevel(s.level);
  const upcoming = nextRankAfter(s.level);
  const out = ['⟦  S T A T U S  ⟧'];
  if (nowText) out.push(nowText);
  out.push(`LEVEL ${s.level} · ${rank.title}`);
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
    coachDebuffs: [],
  };
}

async function getState() {
  let s = await col('system').findOne({ _id: 'state' });
  if (!s) {
    // A brand-new user's first message reads state from several places at once (energy,
    // current state, recording the action), so two of them can race to create it. Losing
    // that race is fine — just re-read what the winner inserted.
    try {
      await col('system').insertOne(freshState());
    } catch (e) {
      if (e?.code !== 11000) throw e;
    }
    s = (await col('system').findOne({ _id: 'state' })) || freshState();
  }
  // Ensure every stat exists, even on states seeded before a stat was added.
  s.stats = { vitality: 0, mind: 0, forge: 0, discipline: 0, spirit: 0, ...s.stats };
  s.condition = s.condition || {};
  s.coachDebuffs = activeCoachDebuffs(s); // drop any that have expired
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
    // A missed day breaks the streak: if the last counted day isn't yesterday (or today),
    // the wheel stopped turning — the mirror must say so. (Was a bug: streak never reset.)
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    if (s.streakDate && s.streakDate !== yesterday && s.streakDate !== today) s.streak = 0;
    s.questDate = today;
    s.quests = {};
    s.breadthAwarded = 0;
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
    const gain = Math.round(xp * mult * balanceMultiplier(s.stats[stat], s.stats));
    s.stats[stat] = (s.stats[stat] || 0) + gain;
    s.xp += gain;
  }

  // Training a domain rebuilds its condition (recovers detraining over sessions).
  const trained = DOMAIN_BY_ACTION[action.type];
  if (trained) bumpCondition(s, trained);

  // Quests — the daily checklist (ping on first completion; XP comes from the action itself).
  rollDay(s);
  const todayLogs = await todaysLogs();
  const now = questsFromLogs(todayLogs);
  for (const k of QUEST_KEYS) {
    if (now[k] && !s.quests[k]) {
      s.quests[k] = true;
      pings.push(`⟦ DAILY QUEST ⟧ ${QUEST_LABEL[k]} — done.`);
    }
  }

  // DISCIPLINE rewards BREADTH — doing several DIFFERENT sides of life, not grinding one.
  // Each new domain touched today earns discipline once; repeating one thing earns nothing.
  const breadth = domainsToday(todayLogs).size;
  if (breadth > (s.breadthAwarded || 0)) {
    const fresh = breadth - (s.breadthAwarded || 0);
    const gain = Math.round(fresh * 12 * balanceMultiplier(s.stats.discipline, s.stats));
    s.stats.discipline += gain;
    s.xp += gain;
    s.breadthAwarded = breadth;
    pings.push(`⟦ DISCIPLINE ⟧ ${breadth} sides of life today.  +${gain}`);
  }

  // STREAK — a day counts if he kept the wheel turning (2+ different sides of life),
  // not the old all-four-quests bar that his real days never hit.
  if (breadth >= 2 && s.streakDate !== s.questDate) {
    s.streakDate = s.questDate;
    s.streak = (s.streak || 0) + 1;
    pings.push(`⟦ STREAK ⟧ ${s.streak} days 🔥 — kept the wheel turning.`);
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
  log_study: 'mind',
  log_english: 'mind',
};

// Current decayed condition for a domain (null if he's never trained it — no debuff then).
function currentCondition(s, domain) {
  const c = s.condition && s.condition[domain];
  if (!c) return null;
  const idleDays = (Date.now() - new Date(c.ts).getTime()) / DAY;
  return decayCondition(c.v, c.mastery || 0, idleDays);
}

// Apply one session: decay to now, add the recovery gain, and ingrain a little more mastery.
function bumpCondition(s, domain) {
  s.condition = s.condition || {};
  const c = s.condition[domain];
  const now = new Date();
  if (!c) {
    // First session in a domain: he's clearly active now — start in decent form.
    s.condition[domain] = { v: CONDITION.initForm, mastery: masteryAfterSession(0), ts: now };
    return;
  }
  const idleDays = (now.getTime() - new Date(c.ts).getTime()) / DAY;
  const mastery = c.mastery || 0;
  const v = clamp(decayCondition(c.v, mastery, idleDays) + recoveryGain(mastery), 0, 100);
  s.condition[domain] = { v, mastery: masteryAfterSession(mastery), ts: now };
}

// ---------------- coach-placed inner debuffs (anxiety, fear, burnout…) -------------
// The coach can place a debuff it SENSES from how he's behaving — a real inner weight, not
// a tracked metric. Each auto-expires; the coach lifts it when it senses the weight passing.
const DEBUFF_SEVERITY = {
  mild: { xpMult: 0.92, energyCap: 100 },
  moderate: { xpMult: 0.82, energyCap: 75 },
  heavy: { xpMult: 0.7, energyCap: 55 },
};

function activeCoachDebuffs(s) {
  // The coach lifts them, but a 7-day safety cap ensures none can stick forever if forgotten.
  const cutoff = Date.now() - 7 * DAY;
  return (s.coachDebuffs || []).filter((d) => !d.placedAt || new Date(d.placedAt).getTime() > cutoff);
}

export async function applyCoachDebuff({ key, label, note, severity = 'moderate' }) {
  if (!key) return;
  const s = await getState();
  const eff = DEBUFF_SEVERITY[severity] || DEBUFF_SEVERITY.moderate;
  s.coachDebuffs = (s.coachDebuffs || []).filter((d) => d.key !== key);
  // No timer: it stays until the coach clears it once his actions have earned its removal.
  s.coachDebuffs.push({ key, label: label || key.toUpperCase(), note: note || '', xpMult: eff.xpMult, energyCap: eff.energyCap, placedAt: new Date() });
  await saveState(s);
}

export async function clearCoachDebuff(key) {
  const s = await getState();
  s.coachDebuffs = activeCoachDebuffs(s).filter((d) => d.key !== key);
  await saveState(s);
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
  for (const d of activeCoachDebuffs(s)) effects.debuffs.push(d); // inner weights the coach sensed
  const base = energyFrom({ sleepHours, waterLitres: todayWater });
  const ceiling = Math.min(base, energyCap(effects));
  const energy = clamp(ceiling - dayDrain(new Date().getHours()), 5, 100);
  return { energy, sleepHours, todayWater, yesterdayWater, effects };
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
  // Reflect today's real logs exactly — a quest un-checks if its data is corrected down.
  const logs = await todaysLogs();
  s.quests = questsFromLogs(logs);
  await saveState(s);
  const { energy, effects } = await energySnapshot();
  const nowText =
    new Date().toLocaleString('en-IE', {
      timeZone: config.timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }) + '  ·  today resets at midnight';
  return renderStatus(s, energy, effects, questProgress(logs), nowText);
}
