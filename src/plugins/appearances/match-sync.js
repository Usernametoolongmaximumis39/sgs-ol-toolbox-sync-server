import { eligibleMode, retainedScope } from './battle.js';
import { sideOf } from './groups.js';

import { MATCH_SYNC_LIMIT, sameGenerals, sameSyncMatch } from '../../shared/match-sync-records.js';
export { MATCH_SYNC_LIMIT, sameSyncMatch } from '../../shared/match-sync-records.js';

export const MATCH_SYNC_BYTES = 16 * 1024 * 1024;

const validGenerals = (value, limit) => Array.isArray(value) && value.length > 0 && value.length <= limit
  && value.every(id => Number.isSafeInteger(id) && id > 0);

export function projectSyncMatch(row) {
  const mode = eligibleMode(row?.rawMode, row?.rawGroup);
  if (!mode || row.mode !== mode || typeof row.gameId !== 'string' || !/^[1-9]\d{0,19}$/.test(row.gameId)
    || BigInt(row.gameId) > 0xffffffffffffffffn || ![0, 1, 255].includes(row.result)
    || !validGenerals(row.general, 8)
    || !Number.isSafeInteger(row.endedAt) || !Number.isFinite(row.duration)
    || row.duration < 0 || row.endedAt <= row.duration * 1000 || sideOf(row) === 'unknown') return null;
  const match = { gameId: row.gameId, mode, rawMode: row.rawMode, rawGroup: row.rawGroup,
    endedAt: row.endedAt, general: [...new Set(row.general)].sort((a, b) => a - b),
    result: row.result, duration: row.duration, position: mode === 35 ? null : row.position,
    figure: mode === 35 ? row.figure : null };
  if (row.frame !== undefined) {
    const frame = projectSyncFrame(row.frame, match.general);
    if (!frame) return null;
    match.frame = frame;
  }
  return match;
}

function projectSyncFrame(frame, selected) {
  if (!Number.isSafeInteger(frame?.time) || frame.time <= 0 || !validGenerals(frame.general, 256)
    || !selected.every(id => frame.general.includes(id))) return null;
  return { time: frame.time, general: [...new Set(frame.general)] };
}

export async function exchangeSyncMatches(exchange, account, records, matches, signal, names) {
  const frames = new Map(records.map(row => [row.id, row]));
  const verified = new Map();
  for (const row of matches) {
    if (row.source !== 'official-history' || row.modeEvidence !== 'official-history' || row.syncUnverified) continue;
    const match = projectSyncMatch(row);
    if (!match) continue;
    const local = frames.get(row.id);
    if (local?.source === 'toolbox' && local.mode === row.mode && retainedScope(local)
      && (local.selected === null || Array.isArray(local.selected) && sameGenerals(local.selected, match.general))) {
      const frame = projectSyncFrame(local, match.general);
      if (frame) match.frame = frame;
    }
    verified.set(match.gameId, match);
  }
  const exported = [...verified.values()];
  const seenGenerals = names ? new Set(exported.flatMap(row => row.frame?.general ?? row.general)) : [];
  const labels = Object.fromEntries([...seenGenerals].filter(id => typeof names[id] === 'string' && names[id].trim())
    .map(id => [id, names[id].trim().slice(0, 60)]));
  const received = await exchange(account, exported, signal, Object.keys(labels).length ? labels : undefined);
  if (!Array.isArray(received) || received.length > MATCH_SYNC_LIMIT) throw new Error('同步回复格式无效');
  const rows = received.map(projectSyncMatch);
  if (rows.some(row => !row) || new Set(rows.map(row => row.gameId)).size !== rows.length)
    throw new Error('同步回复包含无效战绩');
  return rows;
}

export function mergeSyncMatches(records, matches, incoming) {
  const byGameId = new Map(matches.filter(row => row.gameId).map(row => [row.gameId, row]));
  const localIds = new Set([...records, ...matches].map(row => row.id));
  const knownFrames = new Set(records.map(row => row.id));
  const localMatches = new Map(matches.map(row => [row.id, row]));
  const unlinked = [...records.filter(row => !localMatches.get(row.id)?.gameId), ...matches.filter(row => !row.gameId)];
  const addedMatches = [], addedFrames = [];
  let skipped = 0;
  for (const { frame, ...row } of incoming) {
    const id = `official:${row.gameId}`, time = row.endedAt - row.duration * 1000;
    const existing = byGameId.get(row.gameId);
    if (existing && (!frame || knownFrames.has(existing.id))) continue;
    // Leave possible local copies to the official history path, which can also
    // verify and repair an old frame attributed to the teammate.
    const overlaps = unlinked.some(local => local.mode === row.mode &&
      (local.time >= time - 120000 && local.time <= time + 30000
        || Math.abs(local.endedAt - row.endedAt) <= 15000));
    if (overlaps || (existing ? !sameSyncMatch(existing, row) : localIds.has(id) || matches.length + addedMatches.length >= MATCH_SYNC_LIMIT)) {
      skipped++; continue;
    }
    const match = existing ?? { ...row, id, time: frame?.time ?? time, modeEvidence: 'official-history', source: 'local-sync', seat: null };
    if (!existing) addedMatches.push(match);
    if (frame && records.length + addedFrames.length < MATCH_SYNC_LIMIT) {
      const { id, mode, rawMode, rawGroup, position, figure, seat } = match;
      addedFrames.push({ id, mode, rawMode, rawGroup, position, figure, seat, time: frame.time,
        general: frame.general, selected: row.general, source: 'local-sync', modeEvidence: 'official-history' });
    } else if (frame) skipped++;
  }
  return { addedMatches, addedFrames, skipped };
}
