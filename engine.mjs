/** Pure timing state: every transition uses wall-clock timestamps, never tick counts. */
const freshRep = index => ({index, starts: {}, finishes: {}, skipped: [], unassigned: [], splits: {}, closed: false});
const clone = value => JSON.parse(JSON.stringify(value));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const totalReps = group => getPlan(group).length;
const isFinal = group => group.mode === 'planned' && group.repIndex >= totalReps(group) - 1;
const touched = rep => rep.closed || Object.keys(rep.starts).length || Object.keys(rep.finishes).length || rep.skipped.length || rep.unassigned.length;
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
  const steps = [], blocks = [];
  let pendingRest = null;
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    const line = lineIndex + 1;
    let input = raw.trim().replace(/[–—−]/g, '-').replace(/×/g, 'x');
    if (!input) continue;
    const restOnly = input.match(new RegExp(`^${durationSource}\\s*(?:rest|break|brea|recovery)$`, 'i'));
    if (restOnly) {
      if (!steps.length) throw lineError(line, 'Add a running block before recovery.');
      if (pendingRest != null) throw lineError(line, 'Combine consecutive recovery lines into one duration.');
      steps.at(-1).restAfterSeconds = durationSeconds(restOnly[1], restOnly[2], line);
      pendingRest = line;
      continue;
    }

    let sets = 1, repetitions = 1, repRest = 0, setRest = null;
    const setMatch = input.match(/^(\d+)\s+sets?\s+(?:of\s+)?/i);
    if (setMatch) {sets = Number(setMatch[1]); input = input.slice(setMatch[0].length).trim();}
    const betweenMatch = input.match(new RegExp(`[,;]?\\s*${durationSource}\\s+(?:rest\\s+)?between\\s+sets$`, 'i'));
    if (betweenMatch) {
      if (!setMatch) throw lineError(line, 'Use “2 sets of 4x400 1min rest, 6min between sets” for set recovery.');
      setRest = durationSeconds(betweenMatch[1], betweenMatch[2], line);
      input = input.slice(0, betweenMatch.index).trim();
    }
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
    if (!sets || !repetitions || sets * count + steps.length > MAX_RUNS) throw lineError(line, 'Use at least one run and no more than 1,000 runs per workout.');
    const baseTitle = `${repetitions > 1 ? `${repetitions} × ` : ''}${distances.length === 1 ? distanceLabel(distances[0]) : `${distances.join('–')}m`}${description ? ` ${description}` : ''}`;
    for (let set = 0; set < sets; set++) {
      const blockIndex = blocks.length;
      const blockTitle = sets > 1 ? `Set ${set + 1} · ${baseTitle}` : baseTitle;
      const startIndex = steps.length;
      blocks.push({title: blockTitle, startIndex, count});
      for (let i = 0; i < count; i++) {
        const distance = distances[i % distances.length];
        steps.push({index: steps.length, distance, splits: splitDistances(splitSpec, distance), label: `${distanceLabel(distance)}${description ? ` ${description}` : ''}`,
          blockIndex, blockTitle, repInBlock: i + 1, repsInBlock: count,
          restAfterSeconds: i === count - 1 && set < sets - 1 ? setRest ?? repRest : repRest,
          repeatRestSeconds: repRest});
      }
    }
    pendingRest = null;
  }
  if (!steps.length) throw new Error('Add at least one running block.');
  if (pendingRest != null) throw lineError(pendingRest, 'Add the next running block after this recovery, or remove the final recovery line.');
  steps.at(-1).restAfterSeconds = 0;
  return {steps, blocks, title: blocks.map(block => block.title).join(' → ')};
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
  if (group.mode === 'free') return {index, distance: group.distance, label: distanceLabel(group.distance), blockIndex: 0,
    blockTitle: 'Free timing', repInBlock: index + 1, repsInBlock: null, restAfterSeconds: group.restSeconds, repeatRestSeconds: group.restSeconds};
  return getPlan(group)[index] || null;
}

export function workoutSummary(group) {
  if (group.mode === 'free') return 'Free timing';
  if (!group.workoutText) return `${group.sets} × ${group.repsPerSet} × ${distanceLabel(group.distance)}`;
  return [...new Set(getPlan(group).map(step => step.blockTitle))].join(' → ');
}

function makeGroup(id, values = {}) {
  const names = values.athleteNames || [ 'Johnny Forte', 'Lorenzo Pantaleo', 'Arthur Sweeny', 'Aiden Victorio', 'Nick Lawrence', 'Santino Jimenez'];
  if (!Array.isArray(names) || !names.length || names.some(n => !String(n).trim())) throw new Error('Add at least one athlete with a name.');
  const mode = values.mode === 'free' ? 'free' : 'planned';
  if (values.workoutText != null && typeof values.workoutText !== 'string') throw new Error('Enter the workout as text.');
  const workoutText = (values.workoutText || '').trim();
  if (workoutText.length > 8000) throw new Error('Keep the workout under 8,000 characters.');
  const plan = workoutText && mode === 'planned' ? parseWorkout(workoutText).steps : null;
  return {
    id, name: String(values.name || 'New group').trim(), color: values.color === 'orange' ? 'orange' : 'green',
    mode, workoutText, plan,
    sets: Math.floor(number(values.sets, 2, 1, 20)),
    repsPerSet: Math.floor(number(values.repsPerSet, 4, 1, 50)),
    distance: number(values.distance, 400, 1, 100000),
    restSeconds: number(values.restSeconds, 60), setRestSeconds: number(values.setRestSeconds, 360),
    recoveryMode: values.recoveryMode === 'manual' ? 'manual' : 'auto',
    athletes: names.map((name, i) => ({id: `${id}-athlete-${i + 1}`, name: String(name).trim()})),
    repIndex: 0, extraReps: 0, records: [freshRep(0)], recovery: null, completed: false,
  };
}

export function createSession(now = Date.now()) {
  return {id: `session-${now}`, name: 'Afternoon practice', createdAt: now,
    groups: [makeGroup('group-a', {name: 'Distance', workoutText: SAMPLE_WORKOUT}), makeGroup('group-b', {
      name: 'Mid Distance', color: 'orange', sets: 2, repsPerSet: 4, distance: 400,
      restSeconds: 60, setRestSeconds: 360, athleteNames: ['Nick Lawrence', 'Daniel Sanchez', 'Eddie Panniccia', 'Myles Taylor', 'Ethan Wu'],
    })], activeGroupId: 'group-a'};
}

export function getGroup(state, id = state.activeGroupId) {
  const group = state.groups.find(g => g.id === id);
  if (!group) throw new Error('Group not found.');
  return group;
}

export const currentRep = group => group.records.find(rep => rep.index === group.repIndex);

export function recoveryRemaining(group, now = Date.now()) {
  return group.recovery ? Math.max(0, group.recovery.durationMs - (now - group.recovery.startedAt)) : 0;
}

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
    group.recovery = {startedAt, durationMs: restDuration(group), manual: false};
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
  const group = getGroup(next, action.groupId);
  const rep = currentRep(group);
  if (action.type === 'UPDATE_GROUP') {
    if (group.records.some(touched)) throw new Error('Edit a group before recording its first rep.');
    const updated = makeGroup(group.id, {...group, athleteNames: group.athletes.map(a => a.name), ...action.values});
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
        last.restAfterSeconds = last.repeatRestSeconds ?? group.restSeconds;
        for (const step of group.plan) if (step.blockIndex === last.blockIndex) {
          step.repsInBlock += 1;
          if (!step.blockTitle.endsWith(' + extra reps')) step.blockTitle += ' + extra reps';
        }
        group.plan.push({...last, index: last.index + 1, repInBlock: last.repInBlock + 1,
          label: `${last.label.replace(/ · extra$/, '')} · extra`, restAfterSeconds: 0});
      }
    }
    if (group.completed || rep.closed) {
      group.completed = false; group.recovery = null; group.repIndex += 1;
      group.records.push(freshRep(group.repIndex));
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
    case 'START_RECOVERY':
      if (!group.recovery) group.recovery = {startedAt: now, durationMs: restDuration(group), manual: true};
      break;
    case 'ADD_REST':
      if (!group.recovery) throw new Error('Start recovery first.');
      group.recovery.durationMs += number(action.seconds, 30, 0, 86400) * 1000;
      break;
    case 'NEXT_REP':
      rep.closed = true;
      rep.closedAt = now;
      group.recovery = null;
      if (isFinal(group)) group.completed = true;
      else {group.repIndex += 1; group.records.push(freshRep(group.repIndex));}
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

export function exportCsv(state) {
  const maxSplits = Math.max(0, ...state.groups.flatMap(g => g.records.map(r => Math.max(0, ...Object.values(r.splits || {}).map(l => l.length)))));
  const splitHeaders = Array.from({length: maxSplits}, (_, i) => [`split_${i + 1}_label`, `split_${i + 1}_seconds`]).flat();
  const rows = [['date', 'group', 'athlete', 'set', 'rep', 'distance', 'status', 'time_seconds', 'source', 'block', 'run_label', ...splitHeaders, ...(maxSplits ? ['after_last_split_seconds'] : [])]];
  const created = new Date(state.createdAt);
  const date = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
  for (const group of state.groups) for (const rep of group.records.filter(touched)) {
    const planStep = getStep(group, rep.index);
    for (const athlete of group.athletes) {
      const finish = rep.finishes[athlete.id];
      rows.push([date, group.name, athlete.name,
        (planStep?.blockIndex ?? 0) + 1,
        planStep?.repInBlock ?? rep.index + 1,
        planStep?.distance ?? group.distance, finish ? 'recorded' : rep.skipped.includes(athlete.id) ? 'skipped' : 'missing',
        finish ? (finish.ms / 1000).toFixed(2) : '', finish ? finish.manual ? 'manual' : 'stopwatch' : '',
        planStep?.blockTitle ?? '', planStep?.label ?? '',
        ...Array.from({length: maxSplits}, (_, i) => { const sp = (rep.splits?.[athlete.id] || [])[i]; return sp ? [splitLabel(planStep, i), (sp.ms / 1000).toFixed(2)] : ['', '']; }).flat(),
        ...(maxSplits ? [(() => { const list = rep.splits?.[athlete.id] || []; return finish && list.length ? ((finish.ms - list.at(-1).ms) / 1000).toFixed(2) : ''; })()] : []),
      ]);
    }
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
