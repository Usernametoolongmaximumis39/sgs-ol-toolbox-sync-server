export const MODES = { 26: '排位赛', 35: '斗地主', 44: '单骑无双' };
export const MATCH_SYNC_LIMIT = 10000;
export const sameGenerals = (left, right) => left.length === right.length && right.every(id => left.includes(id));

export function sameSyncMatch(left, right) {
  return left.mode === right.mode && left.endedAt === right.endedAt && left.result === right.result
    && left.duration === right.duration && sameGenerals(left.general, right.general);
}
