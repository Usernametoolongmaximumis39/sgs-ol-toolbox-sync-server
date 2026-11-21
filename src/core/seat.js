// Display order, fixedViewId and array offsets are layout data, never seat IDs.
const read = fn => { try { return fn(); } catch { return undefined; } };
export function nativeSeatOccupied(ui) {
  // IsFull is the client's playerInfo check. A retained empty controller is
  // not another player; visibility alone is not a roster signal.
  const seat = nativeSeat(ui);
  return read(() => seat.IsFull) !== false;
}
export function nativeSeatPosition(ui) {
  const seat = nativeSeat(ui);
  const value = read(() => seat.FixedViewId) ?? read(() => seat.fixedViewId);
  return Number.isInteger(value) && value >= 1 && value <= 255 ? value : undefined;
}
export function nativeSeat(ui) {
  return read(() => ui.Seat) ?? read(() => ui.seat)
    ?? read(() => ui.cardContainer.Seat) ?? read(() => ui.cardContainer.seat) ?? null;
}
export function nativeSeatId(ui) {
  const seat = nativeSeat(ui);
  for (const value of [read(() => seat.index), read(() => seat.Index), read(() => seat.SeatID),
    read(() => seat.ID), read(() => ui.seatID), read(() => ui.seatId)]) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') continue;
    const id = Number(value);
    if (Number.isInteger(id) && id >= 0 && id < 255) return id;
  }
  return undefined;
}
