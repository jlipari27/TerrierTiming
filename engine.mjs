/** Pure timing state: every transition uses wall-clock timestamps, never tick counts. */
const freshRep = index => ({index, starts: {}, finishes: {}, skipped: [], modSkipped: [], unassigned: [], splits: {}, closed: false});
const clone = value => JSON.parse(JSON.stringify(value));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const totalReps = group => getPlan(group).length;
const isFinal = group => group.mode === 'planned' && group.repIndex >= totalReps(group) - 1;
const plannedSkips = rep => rep.modSkipped || [];
const touched = rep => rep.closed || Object.keys(rep.starts).length || Object.keys(rep.finishes).length || rep.skipped.some(id => !plannedSkips(rep).includes(id)) || rep.unassigned.length;
const MAX_PACKS = 8;

/** A runner's plan for one run: the group's distance unless the coach changed it or skipped it. */
export function athletePlan(group, athlete, index = group.repIndex) {
  const step = getStep(group, index), mod = athlete.mods?.[index] || null;
  const planned = step?.distance ?? group.distance;
  return {planned, distance: mod?.distance ?? planned, skip: !!mod?.skip, modified: !!(mod && (mod.skip || mod.distance != null && mod.distance !== planned))};
}

/** A fresh rep for this group, with any planned skips already applied. */
function freshRepFor(group, index) {
  const rep = freshRep(index);
  for (const athlete of group.athletes) if (athlete.mods?.[index]?.skip) {rep.skipped.push(athlete.id); rep.modSkipped.push(athlete.id);}
  return rep;
}

/** Re-apply planned skips to an open rep after a runner's plan changes. */
function syncPlannedSkips(group, rep) {
  if (rep.closed) return;
  rep.modSkipped ??= [];
  for (const athlete of group.athletes) {
    const wants = !!athlete.mods?.[rep.index]?.skip, planned = rep.modSkipped.includes(athlete.id);
    if (wants && !planned && !has(rep.starts, athlete.id) && !has(rep.finishes, athlete.id) && !rep.skipped.includes(athlete.id)) {rep.skipped.push(athlete.id); rep.modSkipped.push(athlete.id);}
    else if (!wants && planned) {rep.skipped = rep.skipped.filter(id => id !== athlete.id); rep.modSkipped = rep.modSkipped.filter(id => id !== athlete.id);}
  }
}
const completeRep = (group, rep) => group.athletes.every(a => has(rep.finishes, a.id) || rep.skipped.includes(a.id));
const number = (value, fallback, min = 0, max = 86400) => {
  const result = value == null ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new Error('Enter a valid number.');
  return result;
};

export const SAMPLE_WORKOUT = '3200 tempo\n4min rest\n400-600-400-200 2min rest\n4min break\n5x150 90s rest';
const MAX_RUNS = 1000;
const durationSource = '(\\d+(?:\\.\\d+)?)\\s*(minutes?|mins?|min|m|seconds?|secs?|sec|s)';
const distanceSource = '\\d+(?:\\.\\d+)?\\s*(?:km|m)?';
export const isRestLine = text => new RegExp(`^${durationSource}\\s*(?:rest|break|brea|recovery)$`, 'i').test(String(text).trim()) || /^open\s*(?:rest|break|brea|recovery)$/i.test(String(text).trim());
const lineError = (line, message) => new Error(`Line ${line}: ${message}`);
const distanceLabel = distance => `${Number(distance.toFixed(3))}m`;
const MAX_SPLITS = 40;

/** Split points (in meters) inside a run; anything at or beyond the finish is ignored. */
function splitDistances(spec, distance) {
  if (!spec) return [];
  const points = [];
  if (spec.every) for (let d = spec.values[0]; d < distance && points.length < MAX_SPLITS; d += spec.values[0]) points.push(Number(d.toFixed(3)));
  else for (const d of spec.values) if (d < distance) points.push(d);
  return [...new Set(points)].sort((a, b) => a - b);
}

/** Label for the nth (0-based) split of a step: “400m” when planned, otherwise “Split 2”. */
export const splitLabel = (step, n) => step?.splits?.[n] != null ? distanceLabel(step.splits[n]) : `Split ${n + 1}`;
export const splitCapacity = step => step?.splits?.length ? step.splits.length : MAX_SPLITS;

function durationSeconds(amount, unit, line) {
  const seconds = Number(amount) * (/^m/i.test(unit) ? 60 : 1);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw lineError(line, 'Recovery must be between 0 seconds and 24 hours.');
  return seconds;
}

/** Parse a small, explicit workout grammar. Every nonblank line must be understood. */
export function parseWorkout(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Enter a workout, for example “4x400 1min rest”.');
  if (text.length > 8000) throw new Error('Keep the workout under 8,000 characters.');
  const steps = [], blocks = [], lines = [];
  let pendingRest = null;
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    const line = lineIndex + 1;
    let input = raw.trim().replace(/[–—−]/g, '-').replace(/×/g, 'x');
    if (!input) continue;
    if (/^open\s*(?:rest|break|brea|recovery)$/i.test(input)) {
      if (!steps.length) throw lineError(line, 'Add a running block before recovery.');
      if (pendingRest != null) throw lineError(line, 'Combine consecutive recovery lines into one.');
      steps.at(-1).restAfterSeconds = 0; steps.at(-1).restOpen = true;
      lines.at(-1).restText = raw.trim();
      pendingRest = line;
      continue;
    }
    const restOnly = input.match(new RegExp(`^${durationSource}\\s*(?:rest|break|brea|recovery)$`, 'i'));
    if (restOnly) {
      if (!steps.length) throw lineError(line, 'Add a running block before recovery.');
      if (pendingRest != null) throw lineError(line, 'Combine consecutive recovery lines into one duration.');
      steps.at(-1).restAfterSeconds = durationSeconds(restOnly[1], restOnly[2], line);
      lines.at(-1).restText = raw.trim();
      pendingRest = line;
      continue;
    }

    let sets = 1, repetitions = 1, repRest = 0, setRest = null;
    const setMatch = input.match(/^(\d+)\s+sets?\s+(?:of\s+)?/i);
    if (setMatch) {sets = Number(setMatch[1]); input = input.slice(setMatch[0].length).trim();}
    let inlineBreak = null, inlineOpen = false, setOpen = false, repOpen = false;
    const openBreakMatch = input.match(/[,;]\s*open\s*(?:break|brea)$/i);
    if (openBreakMatch) {inlineOpen = true; input = input.slice(0, openBreakMatch.index).trim();}
    const breakMatch = input.match(new RegExp(`[,;]\\s*${durationSource}\\s*(?:break|brea)$`, 'i'));
    if (breakMatch) {
      inlineBreak = durationSeconds(breakMatch[1], breakMatch[2], line);
      input = input.slice(0, breakMatch.index).trim();
    }
    const openBetween = input.match(/[,;]?\s*open\s+(?:rest\s+)?between\s+sets$/i);
    if (openBetween) {
      if (!setMatch) throw lineError(line, 'Use “2 sets of 4x400 1min rest, open rest between sets” for set recovery.');
      setOpen = true; input = input.slice(0, openBetween.index).trim();
    }
    const betweenMatch = input.match(new RegExp(`[,;]?\\s*${durationSource}\\s+(?:rest\\s+)?between\\s+sets$`, 'i'));
    if (betweenMatch) {
      if (!setMatch) throw lineError(line, 'Use “2 sets of 4x400 1min rest, 6min between sets” for set recovery.');
      setRest = durationSeconds(betweenMatch[1], betweenMatch[2], line);
      input = input.slice(0, betweenMatch.index).trim();
    }
    const openRecovery = input.match(/[,;]?\s*(?:with\s+)?open\s+(?:rest|recovery)(?:\s+between\s+(?:reps|runs))?$/i);
    if (openRecovery) {repOpen = true; input = input.slice(0, openRecovery.index).trim();}
    const recoveryMatch = input.match(new RegExp(`[,;]?\\s*(?:with\\s+)?${durationSource}\\s*(?:rest|recovery)(?:\\s+between\\s+(?:reps|runs))?$`, 'i'));
    if (recoveryMatch) {
      repRest = durationSeconds(recoveryMatch[1], recoveryMatch[2], line);
      input = input.slice(0, recoveryMatch.index).trim();
    }
    let splitSpec = null;
    const splitMatch = input.match(/[,;]?\s*(?:with\s+)?splits?\s+(at|every)?\s*(\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*)\s*(km|m)?$/i);
    if (splitMatch) {
      const unit = splitMatch[3]?.toLowerCase() === 'km' ? 1000 : 1;
      const values = splitMatch[2].split(',').map(v => Number(v) * unit);
      if (values.some(v => !(v > 0))) throw lineError(line, 'Split distances must be greater than 0.');
      if (splitMatch[1]?.toLowerCase() === 'every' && values.length > 1) throw lineError(line, 'Use one distance after “every”, such as “splits every 200”.');
      splitSpec = {every: splitMatch[1]?.toLowerCase() === 'every', values};
      input = input.slice(0, splitMatch.index).trim();
    }
    const repeatMatch = input.match(/^(\d+)\s*x\s*/i);
    if (repeatMatch) {repetitions = Number(repeatMatch[1]); input = input.slice(repeatMatch[0].length).trim();}
    const runMatch = input.match(new RegExp(`^(${distanceSource}(?:\\s*[-,]\\s*${distanceSource})*)(?:\\s+([a-z][a-z /&'().]*))?$`, 'i'));
    if (!runMatch) throw lineError(line, 'Use a distance, a ladder such as “400-600-400-200 2min rest”, or repeats such as “5x150 90s rest”.');
    const description = (runMatch[2] || '').trim();
    if (/\b(?:rest|break|recovery|between|sets?|reps?)\b/i.test(description)) throw lineError(line, 'Include a duration with recovery, for example “90s rest”.');
    const distances = runMatch[1].split(/\s*[-,]\s*/).map(token => {
      const match = token.trim().match(/^(\d+(?:\.\d+)?)\s*(km|m)?$/i);
      const distance = Number(match[1]) * (match[2]?.toLowerCase() === 'km' ? 1000 : 1);
      if (distance <= 0 || distance > 100000) throw lineError(line, 'Each distance must be greater than 0 and at most 100,000m.');
      return distance;
    });
    const count = distances.length * repetitions;
    const lineBlocks = [];
    if (!sets || !repetitions || sets * count + steps.length > MAX_RUNS) throw lineError(line, 'Use at least one run and no more than 1,000 runs per workout.');
    const baseTitle = `${repetitions > 1 ? `${repetitions} × ` : ''}${distances.length === 1 ? distanceLabel(distances[0]) : `${distances.join('–')}m`}${description ? ` ${description}` : ''}`;
    for (let set = 0; set < sets; set++) {
      const blockIndex = blocks.length;
      lineBlocks.push(blockIndex);
      const blockTitle = sets > 1 ? `Set ${set + 1} · ${baseTitle}` : baseTitle;
      const startIndex = steps.length;
      blocks.push({title: blockTitle, startIndex, count});
      for (let i = 0; i < count; i++) {
        const distance = distances[i % distances.length];
        const lastOfSet = i === count - 1 && set < sets - 1;
        const open = lastOfSet ? (setOpen || (setRest == null && repOpen)) : repOpen;
        steps.push({index: steps.length, distance, splits: splitDistances(splitSpec, distance), label: `${distanceLabel(distance)}${description ? ` ${description}` : ''}`,
          blockIndex, blockTitle, repInBlock: i + 1, repsInBlock: count,
          restAfterSeconds: open ? 0 : lastOfSet ? setRest ?? repRest : repRest, restOpen: open,
          repeatRestSeconds: repRest, repeatRestOpen: repOpen});
      }
    }
    if (inlineBreak != null) {steps.at(-1).restAfterSeconds = inlineBreak; steps.at(-1).restOpen = false;}
    if (inlineOpen) {steps.at(-1).restAfterSeconds = 0; steps.at(-1).restOpen = true;}
    lines.push({text: raw.trim(), blocks: lineBlocks, restText: ''});
    pendingRest = null;
  }
  if (!steps.length) throw new Error('Add at least one running block.');
  if (pendingRest != null) throw lineError(pendingRest, 'Add the next running block after this recovery, or remove the final recovery line.');
  steps.at(-1).restAfterSeconds = 0; steps.at(-1).restOpen = false;
  return {steps, blocks, lines, title: blocks.map(block => block.title).join(' → ')};
}

/** Legacy set-based sessions remain readable alongside mixed plans. */
export function getPlan(group) {
  if (group.mode === 'free') return [];
  if (Array.isArray(group.plan) && group.plan.length) return group.plan;
  const count = Math.min(MAX_RUNS, group.sets * group.repsPerSet + (group.extraReps || 0));
  return Array.from({length: count}, (_, index) => {
    const blockIndex = Math.floor(index / group.repsPerSet);
    return {index, distance: group.distance, label: distanceLabel(group.distance), blockIndex,
      blockTitle: `Set ${blockIndex + 1} · ${group.repsPerSet} × ${distanceLabel(group.distance)}`,
      repInBlock: index % group.repsPerSet + 1, repsInBlock: Math.min(group.repsPerSet, count - blockIndex * group.repsPerSet),
      restAfterSeconds: index === count - 1 ? 0 : (index + 1) % group.repsPerSet === 0 ? group.setRestSeconds : group.restSeconds,
      repeatRestSeconds: group.restSeconds};
  });
}

export function getStep(group, index = group.repIndex) {
  if (group.mode === 'free') return {index, distance: group.distance, label: group.noDistance ? `Rep ${index + 1}` : distanceLabel(group.distance), blockIndex: 0,
    blockTitle: 'Free timing', repInBlock: index + 1, repsInBlock: null, restAfterSeconds: group.restOpen ? 0 : group.restSeconds, restOpen: !!group.restOpen, repeatRestSeconds: group.restSeconds};
  return getPlan(group)[index] || null;
}

/** The workout as the coach wrote it, one entry per line, each tied to its blocks. Null when there is no written plan. */
export function workoutLines(group) {
  if (group.mode === 'free' || !group.workoutText) return null;
  try {return parseWorkout(group.workoutText).lines;} catch {return null;}
}

export function workoutSummary(group) {
  if (group.mode === 'free') return 'Free timing';
  if (!group.workoutText) return `${group.sets} × ${group.repsPerSet} × ${distanceLabel(group.distance)}`;
  return [...new Set(getPlan(group).map(step => step.blockTitle))].join(' → ');
}

function makeGroup(id, values = {}) {
  const names = values.athleteNames || ['Athlete 1', 'Athlete 2', 'Athlete 3'];
  if (!Array.isArray(names) || !names.length || names.some(n => !String(n).trim())) throw new Error('Add at least one athlete with a name.');
  const mode = values.mode === 'free' ? 'free' : 'planned';
  if (values.workoutText != null && typeof values.workoutText !== 'string') throw new Error('Enter the workout as text.');
  const workoutText = (values.workoutText || '').trim();
  if (workoutText.length > 8000) throw new Error('Keep the workout under 8,000 characters.');
  const plan = workoutText && mode === 'planned' ? parseWorkout(workoutText).steps : null;
  return {
    id, name: String(values.name || 'New group').trim(), color: values.color === 'orange' ? 'orange' : values.color === 'purple' ? 'purple' : 'green',
    sheetColor: ['blue', 'red', 'yellow', 'purple'].includes(values.sheetColor) ? values.sheetColor : values.color === 'orange' ? 'red' : values.color === 'purple' ? 'purple' : 'blue',
    mode, workoutText, plan, restOpen: values.restOpen === true || values.restOpen === 'on', noDistance: !!values.noDistance,
    sets: Math.floor(number(values.sets, 2, 1, 20)),
    repsPerSet: Math.floor(number(values.repsPerSet, 4, 1, 50)),
    distance: number(values.distance, 400, 1, 100000),
    restSeconds: number(values.restSeconds, 60), setRestSeconds: number(values.setRestSeconds, 360),
    recoveryMode: values.recoveryMode === 'manual' ? 'manual' : 'auto',
    athletes: names.map((name, i) => ({id: `${id}-athlete-${i + 1}`, name: String(name).trim(), pack: null, mods: {}, goals: {}})),
    packs: [],
    repIndex: 0, extraReps: 0, records: [freshRep(0)], recovery: null, completed: false,
  };
}

export const SIMPLE_WORKOUT = '4x400 90s rest';
const DEFAULT_PREFS = () => ({finishedToBottom: true, showGoals: true});
/** The default: one simple group with generic names, so a new coach sees a clean example. */
export function createSession(now = Date.now()) {
  return {id: `session-${now}`, name: 'Practice', createdAt: now,
    groups: [makeGroup('group-a', {name: 'Group 1', workoutText: SIMPLE_WORKOUT, athleteNames: ['Athlete 1', 'Athlete 2', 'Athlete 3']})],
    activeGroupId: 'group-a', prefs: DEFAULT_PREFS()};
}
/** The original two-group sample (mixed workout, full roster). Kept for tests and demos. */
export function createSampleSession(now = Date.now()) {
  const roster = ['Johnny Forte', 'Lorenzo Pantaleo', 'Arthur Sweeny', 'Aiden Victorio', 'Nick Lawrence', 'Santino Jimenez'];
  return {id: `session-${now}`, name: 'Afternoon practice', createdAt: now,
    groups: [makeGroup('group-a', {name: 'Distance', workoutText: SAMPLE_WORKOUT, athleteNames: roster}), makeGroup('group-b', {
      name: 'Mid Distance', color: 'orange', sets: 2, repsPerSet: 4, distance: 400,
      restSeconds: 60, setRestSeconds: 360, athleteNames: ['Nick Lawrence', 'Daniel Sanchez', 'Eddie Panniccia', 'Myles Taylor', 'Ethan Wu'],
    })], activeGroupId: 'group-a', prefs: DEFAULT_PREFS()};
}
/** Blank quick start: free timing, three generic runners, open rest that counts up. */
export function createQuickSession(now = Date.now()) {
  return {id: `session-${now}`, name: 'Quick start', createdAt: now,
    groups: [makeGroup('group-a', {name: 'Group 1', mode: 'free', restOpen: true, restSeconds: 0, noDistance: true, athleteNames: ['Athlete 1', 'Athlete 2', 'Athlete 3']})],
    activeGroupId: 'group-a', prefs: DEFAULT_PREFS()};
}

export const plannedDistances = group => { const seen = []; for (const step of getPlan(group)) if (!seen.includes(step.distance)) seen.push(step.distance); return seen; };
/** A runner's goal (seconds) for a run, looked up by the run's planned distance. */
export function goalFor(group, athlete, index = group.repIndex) {
  const goal = athlete.goals?.[getStep(group, index)?.distance];
  return typeof goal === 'number' ? goal : null;
}
const clockText = seconds => { const t = Math.round(seconds * 10) / 10, m = Math.floor(t / 60), sec = t - m * 60; return `${m}:${Number.isInteger(sec) ? String(sec).padStart(2, '0') : sec.toFixed(1).padStart(4, '0')}`; };
/** 'clock' gives 1:15; 'sheet' gives 75 under 100 seconds and 6:40 above, the way coaches write them. */
export function goalText(seconds, style = 'clock') {
  if (seconds == null) return '';
  const t = Math.round(seconds * 10) / 10;
  return style === 'sheet' && t < 100 ? String(t) : clockText(t);
}
export function goalString(group, athlete) {
  const list = plannedDistances(group).map(d => athlete.goals?.[d]);
  let last = list.length - 1; while (last >= 0 && typeof list[last] !== 'number') last--;
  return list.slice(0, last + 1).map(g => typeof g === 'number' ? goalText(g, 'sheet') : '-').join(', ');
}

/** Display order of a group's list: loose runners in order, with each pack sitting below the runner it is anchored to (pack.after; null = top). */
export function layoutItems(group) {
  const packs = group.packs || [];
  const loose = group.athletes.filter(a => !packs.some(p => p.id === a.pack));
  const ids = new Set(loose.map(a => a.id));
  const rank = packs.map((p, i) => ({p, k: p.sub ?? i, i}));
  const anchorOf = p => (p.after != null && ids.has(p.after)) ? p.after : null;
  const at = id => rank.filter(x => anchorOf(x.p) === id).sort((a, b) => a.k - b.k || a.i - b.i).map(x => ({pack: x.p}));
  const items = [...at(null)];
  for (const a of loose) items.push({athlete: a}, ...at(a.id));
  return items;
}
/** After runners move, keep every pack where it visually was: re-anchor each to the nearest earlier runner who is still loose. */
function reanchorPacks(group, oldItems, exclude = null) {
  const ids = new Set(group.athletes.filter(a => !group.packs.some(p => p.id === a.pack) && a.id !== exclude).map(a => a.id));
  oldItems.forEach((it, i) => {
    if (!it.pack) return;
    const p = group.packs.find(x => x.id === it.pack.id);
    if (!p) return;
    let anchor = null;
    for (let j = i - 1; j >= 0; j--) if (oldItems[j].athlete && ids.has(oldItems[j].athlete.id)) {anchor = oldItems[j].athlete.id; break;}
    p.after = anchor;
  });
}

export function getGroup(state, id = state.activeGroupId) {
  const group = state.groups.find(g => g.id === id);
  if (!group) throw new Error('Group not found.');
  return group;
}

export const currentRep = group => group.records.find(rep => rep.index === group.repIndex);

export function recoveryRemaining(group, now = Date.now()) {
  if (!group.recovery) return 0;
  if (group.recovery.open) return Infinity; // open rest never runs out; it counts up
  return Math.max(0, group.recovery.durationMs - (now - group.recovery.startedAt));
}
/** Seconds into an open rest (counts upward), in ms. */
export const recoveryElapsed = (group, now = Date.now()) => group.recovery ? Math.max(0, now - group.recovery.startedAt) : 0;

export function phase(group, now = Date.now()) {
  if (group.completed) return 'complete';
  if (group.recovery) return recoveryRemaining(group, now) > 0 ? 'recovery' : 'ready-next';
  const rep = currentRep(group);
  if (completeRep(group, rep)) return 'ready-next';
  if (Object.keys(rep.starts).length || Object.keys(rep.finishes).length || rep.unassigned.length) return 'running';
  return 'ready';
}

/** Pass {start: rep.starts[id], finish: rep.finishes[id]}. */
export function elapsed(record, now = Date.now()) {
  if (!record) return 0;
  if (typeof record.ms === 'number') return Math.max(0, record.ms);
  if (typeof record.finish?.ms === 'number') return Math.max(0, record.finish.ms);
  const start = record.start ?? record.startedAt;
  if (start == null) return 0;
  const finishAt = typeof record.finish === 'number' ? record.finish : record.finishedAt ?? record.closedAt;
  return Math.max(0, (finishAt ?? now) - start);
}

function restDuration(group) {
  return (getStep(group)?.restAfterSeconds ?? group.restSeconds) * 1000;
}
const restIsOpen = group => !!getStep(group)?.restOpen;
function newRecovery(group, startedAt, manual) {
  return restIsOpen(group) ? {startedAt, durationMs: 0, manual, open: true} : {startedAt, durationMs: restDuration(group), manual};
}

function settle(group, now, manualEntry = false) {
  const rep = currentRep(group);
  if (!completeRep(group, rep)) return;
  if (isFinal(group)) {
    group.completed = true;
    rep.closed = true;
    rep.closedAt = now;
    group.recovery = null;
  } else if (group.recoveryMode === 'auto' && !group.recovery) {
    const finishTimes = Object.values(rep.finishes).map(f => f.at);
    const startedAt = manualEntry || !finishTimes.length ? now : Math.max(...finishTimes);
    group.recovery = newRecovery(group, startedAt, false);
  }
}

export function act(state, action, now = Date.now()) {
  const next = clone(state);
  if (action.type === 'SELECT_GROUP') {getGroup(next, action.groupId); next.activeGroupId = action.groupId; return next;}
  if (action.type === 'ADD_GROUP') {
    let id = `group-${now}`;
    while (next.groups.some(g => g.id === id)) id += '-new';
    next.groups.push(makeGroup(id, action.values)); next.activeGroupId = id; return next;
  }
  if (action.type === 'END_SESSION') {
    for (const group of next.groups) {
      const active = currentRep(group);
      if (touched(active)) {active.closed = true; active.closedAt ??= now;}
      group.completed = true; group.recovery = null;
    }
    next.completed = true; return next;
  }
  if (action.type === 'SET_PREF') {
    if (!['finishedToBottom', 'showGoals'].includes(action.key)) throw new Error('Unknown setting.');
    next.prefs = {...(next.prefs || {}), [action.key]: !!action.value}; return next;
  }
  const group = getGroup(next, action.groupId);
  const rep = currentRep(group);
  group.packs ??= [];
  rep.modSkipped ??= [];
  if (action.type === 'DELETE_GROUP') {
    if (next.groups.length <= 1) throw new Error('A session needs at least one group.');
    next.groups = next.groups.filter(g => g.id !== group.id);
    if (next.activeGroupId === group.id) next.activeGroupId = next.groups[0].id;
    return next;
  }
  if (action.type === 'DELETE_ATHLETE') {
    if (!group.athletes.some(a => a.id === action.athleteId)) throw new Error('Athlete not found.');
    if (group.athletes.length <= 1) throw new Error('A group needs at least one runner.');
    const oldItems = layoutItems(group);
    group.athletes = group.athletes.filter(a => a.id !== action.athleteId);
    reanchorPacks(group, oldItems, action.athleteId);
    for (const r of group.records) {
      delete r.starts[action.athleteId]; delete r.finishes[action.athleteId]; delete r.splits?.[action.athleteId];
      r.skipped = r.skipped.filter(id => id !== action.athleteId); r.modSkipped = (r.modSkipped || []).filter(id => id !== action.athleteId);
    }
    if (!group.completed && !rep.closed && touched(rep)) settle(group, now, true);
    return next;
  }
  if (action.type === 'ADD_ATHLETE') {
    const name = String(action.name || '').trim();
    if (!name) throw new Error('Enter a name.');
    if (group.athletes.length >= 50) throw new Error('Use up to 50 runners per group.');
    const used = group.athletes.map(a => Number(a.id.split('-athlete-')[1]) || 0);
    const id = `${group.id}-athlete-${Math.max(0, ...used) + 1}`;
    group.athletes.push({id, name, pack: null, mods: {}, goals: {}});
    for (const r of group.records) if (r.index < group.repIndex || r.closed) {r.skipped.push(id); r.modSkipped.push(id);}
    return next;
  }
  if (action.type === 'MOVE_ATHLETE') {
    const index = group.athletes.findIndex(a => a.id === action.athleteId);
    if (index < 0) throw new Error('Athlete not found.');
    const oldItems = layoutItems(group);
    const [athlete] = group.athletes.splice(index, 1);
    if (action.packId !== undefined) {
      if (action.packId !== null && !group.packs.some(p => p.id === action.packId)) throw new Error('Pack not found.');
      athlete.pack = action.packId;
    }
    let at = group.athletes.length;
    if (action.beforeId) at = group.athletes.findIndex(a => a.id === action.beforeId);
    else if (action.afterId) at = group.athletes.findIndex(a => a.id === action.afterId) + 1;
    group.athletes.splice(at < 0 ? group.athletes.length : at, 0, athlete);
    reanchorPacks(group, oldItems, athlete.id);
    if (action.abovePackId && !athlete.pack) {
      const p = group.packs.find(x => x.id === action.abovePackId);
      if (p) p.after = athlete.id;
    }
    return next;
  }
  if (action.type === 'MOVE_PACK') {
    const pack = group.packs.find(p => p.id === action.packId);
    if (!pack) throw new Error('Pack not found.');
    const loose = group.athletes.filter(a => !group.packs.some(p => p.id === a.pack));
    const keyOf = p => p.sub ?? group.packs.indexOf(p);
    if (action.to === 'top' || action.to === 'bottom') {
      const keys = group.packs.map(keyOf);
      if (action.to === 'top') {pack.after = null; pack.sub = Math.min(...keys) - 1;}
      else {pack.after = loose.length ? loose.at(-1).id : null; pack.sub = Math.max(...keys) + 1;}
      return next;
    }
    const items = layoutItems(group), idx = items.findIndex(x => x.pack?.id === pack.id), dir = action.dir < 0 ? -1 : 1;
    const neighbor = items[idx + dir];
    if (!neighbor) return next;
    if (neighbor.pack) {
      const mine = keyOf(pack), theirs = keyOf(neighbor.pack);
      if (mine === theirs) pack.sub = theirs + dir * 0.5;
      else {pack.sub = theirs; neighbor.pack.sub = mine;}
    } else {
      const li = loose.findIndex(a => a.id === neighbor.athlete.id);
      pack.after = dir < 0 ? (li > 0 ? loose[li - 1].id : null) : neighbor.athlete.id;
      const others = group.packs.filter(p => p !== pack && (p.after ?? null) === pack.after).map(keyOf);
      if (others.length) pack.sub = dir < 0 ? Math.max(...others) + 1 : Math.min(...others) - 1;
    }
    return next;
  }
  if (action.type === 'SET_GOALS') {
    const athlete = group.athletes.find(a => a.id === action.athleteId);
    if (!athlete) throw new Error('Athlete not found.');
    athlete.goals ??= {};
    for (const [key, value] of Object.entries(action.goals || {})) {
      const distance = Number(key);
      if (!(distance > 0)) throw new Error('That distance is not valid.');
      if (value == null || value === '') delete athlete.goals[distance];
      else { const seconds = typeof value === 'number' ? value : timeSeconds(value); athlete.goals[distance] = number(seconds, NaN, 1, 86400); }
    }
    return next;
  }
  if (action.type === 'SET_PACKS') {
    const oldItems = layoutItems(group);
    const packs = (action.packs || []).map((p, i) => {
      const old = group.packs.find(x => x.id === String(p.id));
      return {id: String(p.id), name: String(p.name || '').trim() || `Pack ${i + 1}`, ...(old?.after != null ? {after: old.after} : {}), ...(old?.sub != null ? {sub: old.sub} : {})};
    });
    if (packs.length > MAX_PACKS) throw new Error(`Use up to ${MAX_PACKS} packs.`);
    if (new Set(packs.map(p => p.id)).size !== packs.length) throw new Error('Pack ids must be unique.');
    group.packs = packs;
    for (const athlete of group.athletes) {
      const wanted = action.assignments && has(action.assignments, athlete.id) ? action.assignments[athlete.id] : athlete.pack;
      athlete.pack = packs.some(p => p.id === wanted) ? wanted : null;
    }
    reanchorPacks(group, oldItems);
    return next;
  }
  if (action.type === 'SET_MODS') {
    if (group.mode === 'free') throw new Error('Per-runner changes need a planned workout.');
    const ids = action.athleteIds || [];
    const targets = group.athletes.filter(a => ids.includes(a.id));
    if (!targets.length) throw new Error('Choose at least one runner.');
    for (const [key, change] of Object.entries(action.changes || {})) {
      const step = Number(key);
      if (!Number.isInteger(step) || step < 0 || step >= totalReps(group)) throw new Error('That run is not part of the workout.');
      let value = null;
      if (change?.skip) value = {skip: true};
      else if (change?.distance != null) value = {distance: number(change.distance, NaN, 1, 100000)};
      for (const athlete of targets) {
        athlete.mods ??= {};
        if (value) athlete.mods[step] = clone(value); else delete athlete.mods[step];
      }
    }
    if (!group.completed) {
      syncPlannedSkips(group, rep);
      if (touched(rep)) settle(group, now, true);
    }
    return next;
  }
  if (action.type === 'UPDATE_GROUP') {
    if (group.records.some(touched)) throw new Error('Edit a group before recording its first rep.');
    const updated = makeGroup(group.id, {...group, athleteNames: group.athletes.map(a => a.name), ...action.values});
    updated.packs = group.packs || [];
    const sameWorkout = updated.workoutText === group.workoutText && updated.mode === group.mode;
    for (const athlete of updated.athletes) {
      const old = group.athletes.find(o => o.name === athlete.name);
      if (!old) continue;
      if (old.pack && updated.packs.some(p => p.id === old.pack)) athlete.pack = old.pack;
      athlete.goals = clone(old.goals || {});
      if (sameWorkout) athlete.mods = clone(old.mods || {});
    }
    syncPlannedSkips(updated, updated.records[0]);
    next.groups[next.groups.findIndex(g => g.id === group.id)] = updated;
    return next;
  }
  if (action.type === 'SET_RECOVERY_MODE') {
    if (!['auto', 'manual'].includes(action.mode)) throw new Error('Choose automatic or manual recovery.');
    group.recoveryMode = action.mode; return next;
  }
  if (action.type === 'ADD_REP') {
    if (group.mode === 'planned') {
      if (totalReps(group) >= MAX_RUNS) throw new Error('A workout can contain at most 1,000 runs.');
      group.extraReps = (group.extraReps || 0) + 1;
      if (Array.isArray(group.plan) && group.plan.length) {
        const last = group.plan.at(-1);
        last.restAfterSeconds = last.repeatRestSeconds ?? group.restSeconds; last.restOpen = !!last.repeatRestOpen;
        if (last.restOpen) last.restAfterSeconds = 0;
        for (const step of group.plan) if (step.blockIndex === last.blockIndex) {
          step.repsInBlock += 1;
          if (!step.blockTitle.endsWith(' + extra reps')) step.blockTitle += ' + extra reps';
        }
        group.plan.push({...last, index: last.index + 1, repInBlock: last.repInBlock + 1,
          label: `${last.label.replace(/ · extra$/, '')} · extra`, restAfterSeconds: 0, restOpen: false});
      }
    }
    if (group.completed || rep.closed) {
      group.completed = false; group.recovery = null; group.repIndex += 1;
      group.records.push(freshRepFor(group, group.repIndex));
      next.completed = false;
    }
    return next;
  }
  if (action.type === 'CLEAR_SPLITS') {
    const target = action.repIndex == null ? rep : group.records.find(r => r.index === action.repIndex);
    if (!target) throw new Error('Rep not found.');
    if (target.splits) delete target.splits[action.athleteId];
    return next;
  }
  if (action.type === 'SET_TIME') {
    if (!group.athletes.some(a => a.id === action.athleteId)) throw new Error('Athlete not found.');
    const target = action.repIndex == null ? rep : group.records.find(r => r.index === action.repIndex);
    if (!target) throw new Error('Rep not found.');
    const ms = Math.round(number(action.ms, NaN, 0, 86400000));
    target.finishes[action.athleteId] = {ms, at: now, manual: true};
    target.skipped = target.skipped.filter(id => id !== action.athleteId);
    if (target === rep && !group.completed) settle(group, now, true);
    return next;
  }
  if (action.type === 'ASSIGN_FINISH') {
    if (!group.athletes.some(a => a.id === action.athleteId)) throw new Error('Athlete not found.');
    const target = action.repIndex == null ? rep : group.records.find(r => r.index === action.repIndex);
    if (!target) throw new Error('Rep not found.');
    const capture = target.unassigned.find(c => c.id === action.captureId);
    if (!capture) throw new Error('Finish capture not found.');
    if (!has(target.starts, action.athleteId)) throw new Error('This athlete has not started.');
    if (has(target.finishes, action.athleteId) || target.skipped.includes(action.athleteId)) throw new Error('This athlete already has a result.');
    if (capture.at < target.starts[action.athleteId]) throw new Error('This finish was captured before the athlete started.');
    target.finishes[action.athleteId] = {ms: capture.at - target.starts[action.athleteId], at: capture.at, manual: false};
    target.unassigned = target.unassigned.filter(c => c.id !== action.captureId);
    if (target === rep && !group.completed && !target.closed) settle(group, now);
    return next;
  }
  if (action.type === 'REMOVE_CAPTURE') {
    const target = action.repIndex == null ? rep : group.records.find(r => r.index === action.repIndex);
    if (!target) throw new Error('Rep not found.');
    if (!target.unassigned.some(c => c.id === action.captureId)) throw new Error('Finish capture not found.');
    target.unassigned = target.unassigned.filter(c => c.id !== action.captureId);
    return next;
  }
  if (action.type === 'SKIP_ATHLETE') {
    if (!group.athletes.some(a => a.id === action.athleteId)) throw new Error('Athlete not found.');
    const target = action.repIndex == null ? rep : group.records.find(r => r.index === action.repIndex);
    if (!target) throw new Error('Rep not found.');
    if (has(target.finishes, action.athleteId)) throw new Error('This athlete already has a time.');
    if (!target.skipped.includes(action.athleteId)) target.skipped.push(action.athleteId);
    if (target === rep && !group.completed && !target.closed) settle(group, now);
    return next;
  }
  if (group.completed || rep.closed) throw new Error('This group is complete.');
  if (action.athleteId != null && !group.athletes.some(a => a.id === action.athleteId)) throw new Error('Athlete not found.');
  switch (action.type) {
    case 'START_ALL':
      for (const athlete of group.athletes) {
        if (!has(rep.starts, athlete.id) && !has(rep.finishes, athlete.id) && !rep.skipped.includes(athlete.id)) rep.starts[athlete.id] = now;
      }
      break;
    case 'START_ONE':
      if (!has(rep.starts, action.athleteId) && !has(rep.finishes, action.athleteId) && !rep.skipped.includes(action.athleteId)) rep.starts[action.athleteId] = now;
      break;
    case 'FINISH':
      if (!has(rep.starts, action.athleteId)) throw new Error('Start this athlete first, or enter a time manually.');
      if (has(rep.finishes, action.athleteId) || rep.skipped.includes(action.athleteId)) throw new Error('This athlete already has a result.');
      rep.finishes[action.athleteId] = {ms: Math.max(0, now - rep.starts[action.athleteId]), at: now, manual: false};
      settle(group, now);
      break;
    case 'QUICK_FINISH': {
      if (!Object.keys(rep.starts).length) throw new Error('Start the rep before capturing a finish.');
      let id = `capture-${now}-${rep.unassigned.length}`;
      while (rep.unassigned.some(c => c.id === id)) id += '-new';
      rep.unassigned.push({id, at: now});
      break;
    }
    case 'SPLIT':
    case 'SPLIT_ALL': {
      rep.splits ??= {};
      const limit = splitCapacity(getStep(group));
      const running = id => has(rep.starts, id) && !has(rep.finishes, id) && !rep.skipped.includes(id);
      const targets = action.type === 'SPLIT' ? [action.athleteId] : group.athletes.map(a => a.id).filter(running);
      if (action.type === 'SPLIT') {
        if (!has(rep.starts, action.athleteId)) throw new Error('Start this athlete before taking a split.');
        if (!running(action.athleteId)) throw new Error('This athlete already finished.');
        if ((rep.splits[action.athleteId] || []).length >= limit) throw new Error('All splits are already recorded for this rep.');
      }
      let taken = 0;
      for (const id of targets) {
        const list = rep.splits[id] ||= [];
        if (list.length >= limit) continue;
        list.push({ms: Math.max(0, now - rep.starts[id]), at: now});
        taken++;
      }
      if (!taken) throw new Error('No runners are available for a split.');
      break;
    }
    case 'START_PACK':
    case 'FINISH_PACK':
    case 'SPLIT_PACK': {
      if (!group.packs.some(p => p.id === action.packId)) throw new Error('Pack not found.');
      const members = group.athletes.filter(a => a.pack === action.packId).map(a => a.id);
      const live = id => has(rep.starts, id) && !has(rep.finishes, id) && !rep.skipped.includes(id);
      if (action.type === 'START_PACK') {
        const ready = members.filter(id => !has(rep.starts, id) && !has(rep.finishes, id) && !rep.skipped.includes(id));
        if (!ready.length) throw new Error('Nobody in this pack is waiting to start.');
        for (const id of ready) rep.starts[id] = now;
      } else if (action.type === 'FINISH_PACK') {
        const running = members.filter(live);
        if (!running.length) throw new Error('Nobody in this pack is running.');
        for (const id of running) rep.finishes[id] = {ms: Math.max(0, now - rep.starts[id]), at: now, manual: false};
        settle(group, now);
      } else {
        const limit = splitCapacity(getStep(group));
        rep.splits ??= {};
        const running = members.filter(id => live(id) && (rep.splits[id] || []).length < limit);
        if (!running.length) throw new Error('Nobody in this pack is available for a split.');
        for (const id of running) (rep.splits[id] ||= []).push({ms: Math.max(0, now - rep.starts[id]), at: now});
      }
      break;
    }
    case 'RESET_REP': {
      // Back to a clean, not-yet-started rep (planned skips stay). Any rest that began from this rep is cancelled.
      const fresh = freshRepFor(group, rep.index);
      Object.assign(rep, {starts: {}, finishes: {}, splits: {}, unassigned: [], skipped: fresh.skipped, modSkipped: fresh.modSkipped});
      group.recovery = null;
      break;
    }
    case 'RESET_REST':
      if (!group.recovery) throw new Error('No rest is running.');
      if (action.stop) group.recovery = null;
      else group.recovery = newRecovery(group, now, group.recovery.manual);
      break;
    case 'START_RECOVERY':
      if (!group.recovery) group.recovery = newRecovery(group, now, true);
      break;
    case 'ADD_REST':
      if (!group.recovery) throw new Error('Start recovery first.');
      if (group.recovery.open) break;
      group.recovery.durationMs += number(action.seconds, 30, 0, 86400) * 1000;
      break;
    case 'NEXT_REP':
      rep.closed = true;
      rep.closedAt = now;
      group.recovery = null;
      if (isFinal(group)) group.completed = true;
      else {group.repIndex += 1; group.records.push(freshRepFor(group, group.repIndex));}
      break;
    default: throw new Error(`Unknown action: ${action.type}`);
  }
  return next;
}

export function formatTime(ms) {
  const centiseconds = Math.floor(Math.max(0, Math.round(Number(ms) || 0)) / 10);
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportDetailCsv(state) {
  const maxSplits = Math.max(0, ...state.groups.flatMap(g => g.records.map(r => Math.max(0, ...Object.values(r.splits || {}).map(l => l.length)))));
  const splitHeaders = Array.from({length: maxSplits}, (_, i) => [`split_${i + 1}_label`, `split_${i + 1}_seconds`]).flat();
  const rows = [['date', 'group', 'athlete', 'pack', 'set', 'rep', 'planned_distance', 'distance', 'status', 'time_seconds', 'source', 'block', 'run_label', ...splitHeaders, ...(maxSplits ? ['after_last_split_seconds'] : [])]];
  const created = new Date(state.createdAt);
  const date = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
  for (const group of state.groups) for (const rep of group.records.filter(touched)) {
    const planStep = getStep(group, rep.index);
    for (const athlete of group.athletes) {
      const finish = rep.finishes[athlete.id];
      const mine = athletePlan(group, athlete, rep.index);
      rows.push([date, group.name, athlete.name, (group.packs || []).find(p => p.id === athlete.pack)?.name ?? '',
        (planStep?.blockIndex ?? 0) + 1,
        planStep?.repInBlock ?? rep.index + 1,
        mine.planned, mine.distance, finish ? 'recorded' : rep.skipped.includes(athlete.id) ? 'skipped' : 'missing',
        finish ? (finish.ms / 1000).toFixed(2) : '', finish ? finish.manual ? 'manual' : 'stopwatch' : '',
        planStep?.blockTitle ?? '', planStep?.label ?? '',
        ...Array.from({length: maxSplits}, (_, i) => { const sp = (rep.splits?.[athlete.id] || [])[i]; return sp ? [splitLabel(planStep, i), (sp.ms / 1000).toFixed(2)] : ['', '']; }).flat(),
        ...(maxSplits ? [(() => { const list = rep.splits?.[athlete.id] || []; return finish && list.length ? ((finish.ms - list.at(-1).ms) / 1000).toFixed(2) : ''; })()] : []),
      ]);
    }
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

/** Short split time for tight spaces: 31.20 or 1:02.15 */
export function shortTime(ms) {
  const cs = Math.floor(Math.max(0, Math.round(Number(ms) || 0)) / 10), minutes = Math.floor(cs / 6000), seconds = Math.floor((cs % 6000) / 100);
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}` : `${seconds}.${String(cs % 100).padStart(2, '0')}`;
}

/** The spreadsheet export: one block per group, laid out like the Results screen (runners down, reps across). */
export function exportCsv(state) {
  const created = new Date(state.createdAt);
  const date = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
  const rows = [[state.name, date]];
  for (const group of state.groups) {
    const n = group.mode === 'free' ? Math.max(1, group.repIndex + 1) : totalReps(group);
    const hasPacks = (group.packs || []).length > 0;
    const recorded = new Set(group.records.filter(touched).map(r => r.index));
    rows.push([]);
    rows.push([group.name, ...(group.workoutText ? [group.workoutText.replace(/\s*\r?\n\s*/g, ' / ')] : [])]);
    rows.push(['Athlete', ...(hasPacks ? ['Pack'] : []),
      ...Array.from({length: n}, (_, i) => { const step = getStep(group, i); return `Rep ${i + 1}: ${step?.label || 'Rep'}`; }), 'Recorded']);
    for (const athlete of group.athletes) {
      const cells = [], notes = [];
      let count = 0;
      for (let i = 0; i < n; i++) {
        const rec = group.records.find(r => r.index === i), finish = rec?.finishes[athlete.id], mine = athletePlan(group, athlete, i);
        if (finish) count++;
        cells.push(finish ? `${formatTime(finish.ms)}${finish.manual ? '*' : ''}` : rec?.skipped.includes(athlete.id) ? ((rec.modSkipped || []).includes(athlete.id) ? 'Skip' : 'DNS') : recorded.has(i) ? 'Missing' : '');
        const splits = (rec?.splits?.[athlete.id] || []).map(sp => formatTime(sp.ms));
        notes.push([mine.modified && !mine.skip ? `${Number(mine.distance.toFixed(3))}m` : '', splits.length ? `splits ${splits.join(' / ')}` : ''].filter(Boolean).join(' · '));
      }
      const pack = (group.packs || []).find(p => p.id === athlete.pack)?.name ?? '';
      rows.push([athlete.name, ...(hasPacks ? [pack] : []), ...cells, `${count} / ${n}`]);
      if (notes.some(Boolean)) rows.push(['   changes & splits', ...(hasPacks ? [''] : []), ...notes]);
    }
  }
  rows.push([], ['* manual entry', 'DNS = did not run', 'Skip = planned skip']);
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}


// ---------- Practice text: groups, goals and per-runner changes ----------
const COLOR_WORDS = {blue: 'blue', red: 'red', yellow: 'yellow', purple: 'purple', violet: 'purple', sprint: 'purple', sprints: 'purple', sprinters: 'purple', green: 'blue', orange: 'red', gold: 'yellow'};
export const PRACTICE_EXAMPLE = `Distance | blue
4x400 45s rest, 6min break
2000, 6min break
2x300 2.5min rest
Pack Front: Johnny, Arthur
Pack Back: Nick
Johnny | 75, 6:40, 47
Arthur | 77, 7:00, 50 | 2000 to 1600
Nick | 77, 7:05, 52 | skip 300

Freshmen | yellow
4x400 60s rest
Landon | 85 | skip rep 3`;
function timeSeconds(text) {
  const t = String(text).trim();
  if (!/^(?:\d+:)?\d+(?:\.\d{1,3})?$/.test(t)) return NaN;
  const parts = t.split(':').map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
}

/** Turn pasted text into groups. A name line starts a group, workout lines use the normal grammar, and “Name | goals | changes” lines are runners. */
export function parsePractice(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste a practice first.');
  if (text.length > 20000) throw new Error('That practice is too long.');
  const groups = [];
  let cur = null;
  const begin = (name, color) => { cur = {name, sheetColor: color || null, lines: [], runners: [], packs: []}; groups.push(cur); };
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const lineNo = i + 1, line = raw.trim().replace(/×/g, 'x');
    if (!line) continue;
    const bars = line.split('|').map(part => part.trim());
    const colorWord = bars.length === 2 ? COLOR_WORDS[bars[1].toLowerCase()] : null;
    if (bars.length > 1 && !colorWord) {
      if (!cur) begin('Practice');
      if (!bars[0]) throw lineError(lineNo, 'Put the runner’s name first, like “Johnny | 75, 6:40, 47”.');
      cur.runners.push({lineNo, name: bars[0], segments: bars.slice(1)});
      continue;
    }
    const packMatch = line.match(/^packs?\s+([^:|]+?)\s*:\s*(.+)$/i);
    if (packMatch) {
      if (!cur) begin('Practice');
      const members = packMatch[2].split(',').map(x => x.trim()).filter(Boolean);
      if (!members.length) throw lineError(lineNo, 'List the runners after the colon, like “Pack Front: Johnny, Lorenzo”.');
      cur.packs.push({lineNo, name: packMatch[1].trim(), members});
      continue;
    }
    if (isRestLine(line)) {
      if (!cur || !cur.lines.length) throw lineError(lineNo, 'Add a running line before this recovery.');
      if (cur.runners.length) throw lineError(lineNo, 'Put the workout lines before the runner list.');
      cur.lines.push(line);
      continue;
    }
    let isWorkout = false;
    try { parseWorkout(line); isWorkout = true; } catch { /* not a workout line, so it names a group */ }
    if (isWorkout) {
      if (!cur) begin('Practice');
      if (cur.runners.length) throw lineError(lineNo, 'Put the workout lines before the runner list, or start a new group with a name line.');
      cur.lines.push(line);
      continue;
    }
    begin(bars[0] || line, colorWord);
  }
  const out = [];
  for (const g of groups) {
    if (!g.lines.length && !g.runners.length) continue;
    if (!g.lines.length) throw new Error(`“${g.name}” needs at least one workout line.`);
    if (!g.runners.length) throw new Error(`“${g.name}” needs at least one runner, like “Johnny | 75, 6:40, 47”.`);
    try { parseWorkout(g.lines.join('\n')); } catch (err) { throw new Error(`${g.name}: ${err.message.replace(/^Line (\d+)/, (_, n) => `workout line ${n}`)}`); }
    out.push({name: g.name, sheetColor: g.sheetColor, workoutText: g.lines.join('\n'), runners: g.runners.map(parseRunner), packs: g.packs});
  }
  if (!out.length) throw new Error('Add a group with a workout and runners.');
  return {groups: out};
}

function parseRunner(r) {
  const goals = [], changes = [];
  for (const segment of r.segments) {
    if (!segment) continue;
    if (/\bto\b|\bskip\b/i.test(segment)) {
      for (const item of segment.split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
        let m;
        if ((m = item.match(/^(\d+(?:\.\d+)?)\s*m?\s*to\s*(\d+(?:\.\d+)?)\s*m?$/i))) changes.push({kind: 'distance', from: Number(m[1]), to: Number(m[2])});
        else if ((m = item.match(/^skip\s+(?:rep|run|#)\s*(\d+)$/i))) changes.push({kind: 'skip-run', run: Number(m[1])});
        else if ((m = item.match(/^skip\s+(\d+(?:\.\d+)?)\s*m?$/i))) changes.push({kind: 'skip-distance', distance: Number(m[1])});
        else throw lineError(r.lineNo, `Didn’t understand “${item}”. Try “2000 to 1600”, “skip 300”, or “skip rep 3”.`);
      }
    } else {
      for (const item of segment.split(',').map(x => x.trim()).filter(Boolean)) {
        const m = item.match(/^(\d+(?:\.\d+)?)\s*=\s*(.+)$/);
        const seconds = timeSeconds(m ? m[2] : item);
        if (!(seconds > 0)) throw lineError(r.lineNo, `“${item}” isn’t a goal time. Use seconds (75) or minutes:seconds (6:40).`);
        goals.push({distance: m ? Number(m[1]) : null, seconds});
      }
    }
  }
  return {lineNo: r.lineNo, name: r.name, goals, changes};
}

/** Positional goals map onto the workout's distinct distances, in order of first appearance. */
function applyRunner(group, spec) {
  const athlete = group.athletes.find(a => a.name === spec.name), plan = getPlan(group), distinct = plannedDistances(group);
  const positional = spec.goals.filter(g => g.distance == null);
  if (positional.length > distinct.length) throw lineError(spec.lineNo, `${spec.name} has ${positional.length} goal paces but this workout has ${distinct.length} different distance${distinct.length === 1 ? '' : 's'} (${distinct.join(', ')}).`);
  positional.forEach((g, i) => { athlete.goals[distinct[i]] = g.seconds; });
  for (const g of spec.goals) if (g.distance != null) athlete.goals[g.distance] = g.seconds;
  for (const c of spec.changes) {
    if (c.kind === 'skip-run') {
      if (c.run < 1 || c.run > plan.length) throw lineError(spec.lineNo, `${spec.name}: this workout only has ${plan.length} runs.`);
      athlete.mods[c.run - 1] = {skip: true};
      continue;
    }
    const wanted = c.kind === 'distance' ? c.from : c.distance, hits = plan.filter(step => step.distance === wanted);
    if (!hits.length) throw lineError(spec.lineNo, `${spec.name}: there is no ${wanted}m run in this workout (${distinct.join(', ')}).`);
    for (const step of hits) athlete.mods[step.index] = c.kind === 'distance' ? {distance: c.to} : {skip: true};
  }
}

/** A brand-new session built from parsed practice text. */
export function createSessionFromPractice(practice, {name = 'Practice', now = Date.now(), prefs} = {}) {
  const palette = ['blue', 'red', 'yellow'];
  const groups = practice.groups.map((spec, i) => {
    const sheetColor = spec.sheetColor || palette[i % 3];
    const group = makeGroup(`group-${i + 1}`, {name: spec.name, workoutText: spec.workoutText, athleteNames: spec.runners.map(r => r.name), sheetColor, color: sheetColor === 'blue' ? 'green' : sheetColor === 'purple' ? 'purple' : 'orange'});
    if (new Set(group.athletes.map(a => a.name)).size !== group.athletes.length) throw new Error(`${spec.name}: each runner’s name should appear once.`);
    for (const runner of spec.runners) applyRunner(group, runner);
    const seen = new Map();
    group.packs = (spec.packs || []).map((pk, pi) => {
      const id = `pack-${pi + 1}`;
      for (const member of pk.members) {
        const athlete = group.athletes.find(a => a.name.toLowerCase() === member.toLowerCase());
        if (!athlete) throw lineError(pk.lineNo, `“${member}” in pack ${pk.name} isn’t a runner in ${spec.name}.`);
        if (seen.has(athlete.id)) throw lineError(pk.lineNo, `${athlete.name} is in more than one pack (${seen.get(athlete.id)} and ${pk.name}).`);
        seen.set(athlete.id, pk.name);
        athlete.pack = id;
      }
      return {id, name: pk.name};
    });
    group.records[0] = freshRepFor(group, 0);
    return group;
  });
  return {id: `session-${now}`, name: String(name || 'Practice').trim() || 'Practice', createdAt: now, groups, activeGroupId: groups[0].id, prefs: {finishedToBottom: true, showGoals: true, ...(prefs || {})}};
}

// ---------- Everything the Google Sheet needs for one group ----------
export function buildSheetPayload(state, groupId) {
  const group = getGroup(state, groupId), created = new Date(state.createdAt), pad = n => String(n).padStart(2, '0');
  const md = `${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;
  const n = group.mode === 'free' ? Math.max(1, group.repIndex + 1) : totalReps(group);
  const recorded = new Set(group.records.filter(touched).map(r => r.index));
  const workout = group.workoutText ? group.workoutText.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [workoutSummary(group)];
  return {
    action: 'results', md, date: `${created.getFullYear()}-${md}`, session: state.name,
    group: {key: group.name, name: group.name, color: group.sheetColor || 'blue', workout, complete: !!group.completed,
      cols: Array.from({length: n}, (_, i) => ({label: group.noDistance && group.mode === 'free' ? `Rep ${i + 1}` : String(getStep(group, i)?.distance ?? group.distance)})),
      athletes: group.athletes.map(a => ({
        name: a.name, goal: goalString(group, a), pack: (group.packs || []).find(p => p.id === a.pack)?.name ?? '',
        cells: Array.from({length: n}, (_, i) => {
          const rec = group.records.find(r => r.index === i), f = rec?.finishes[a.id], mine = athletePlan(group, a, i), notes = [];
          if (mine.modified && !mine.skip) notes.push(`${Number(mine.distance.toFixed(3))}m`);
          const splits = (rec?.splits?.[a.id] || []).map(sp => shortTime(sp.ms));
          if (splits.length) notes.push(`splits ${splits.join(' / ')}`);
          if (f?.manual) notes.push('manual entry');
          const skipped = rec?.skipped.includes(a.id);
          return {s: f ? Math.round(f.ms / 10) / 100 : null, st: f ? 'ok' : skipped ? ((rec.modSkipped || []).includes(a.id) ? 'skip' : 'dns') : recorded.has(i) ? 'missing' : '', note: notes.join(' · ')};
        }),
      }))},
  };
}
