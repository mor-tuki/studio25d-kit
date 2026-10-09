// Server, controls and renderer share this one calibration file (rooms.json).
// Adding a room = append one entry there. A neighbour written on either side
// becomes a two-way door.
const response = await fetch('./rooms.json', { cache: 'no-store' });
if (!response.ok) throw new Error('rooms.json could not be loaded');
const RAW = await response.json();
const IDS = new Set(RAW.map(room => room.id));
export const ROOMS = RAW.map(room => ({
  ...room,
  neighbours: [...new Set([
    ...(room.neighbours || []),
    ...RAW.filter(other => (other.neighbours || []).includes(room.id)).map(other => other.id),
  ])].filter(id => id !== room.id && IDS.has(id)),
}));
export const ROOM_MAP = Object.fromEntries(ROOMS.map(room => [room.id, room]));
export const resolveRoom = id => ROOM_MAP[id] ? id : ROOMS[0].id;
