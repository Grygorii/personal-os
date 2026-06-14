import { col } from './db.js';

const QUEST_LABEL = {
  hydrate: 'Hydrate (2L)',
  read: 'Read / reflect',
  build: 'Ship one thing',
};

// ---------------- pure logic (no DB, unit-testable) ----------------

// Cumulative XP required to BE at a given level (level 1 = 0 XP).
export function xpToReach(level) {
  let total = 0;
  for (let l = 1; l < level; l++) total += 100 + (l - 1) * 50;
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

export function renderStatus(s) {
  const floor = xpToReach(s.level);
  const next = xpToReach(s.level + 1);
  const prog = s.xp - floor;
  const need = next - floor;
  const w = 10;
  const fill = need > 0 ? Math.round((prog / need) * w) : w;
  const xpbar = '▰'.repeat(fill) + '▱'.repeat(w - fill);
  const q = s.quests || {};
  const line = (k) => ` ${q[k] ? '✓' : '▢'} ${QUEST_LABEL[k]}`;

  const out = [
    '⟦  S T A T U S  ⟧',
    `LEVEL ${s.level}`,
    `XP ${xpbar}  ${prog}/${need}`,
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
    line('build'),
  ];
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

  for (const [stat, xp] of awardsFor(action)) {
    s.stats[stat] = (s.stats[stat] || 0) + xp;
    s.xp += xp;
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

// Render the status window (refreshes today's quest state for display).
export async function statusWindow() {
  const s = await getState();
  rollDay(s);
  const now = questsFromLogs(await todaysLogs());
  s.quests = { ...s.quests, ...Object.fromEntries(Object.entries(now).filter(([, v]) => v)) };
  await saveState(s);
  return renderStatus(s);
}
