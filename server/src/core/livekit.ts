import { RoomServiceClient } from 'livekit-server-sdk';

export const LK = { host: process.env.LIVEKIT_HOST!, key: process.env.LIVEKIT_API_KEY!, secret: process.env.LIVEKIT_API_SECRET! };

export const livekitConfigured = () => !!(process.env.LIVEKIT_HOST && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

/** The subset of RoomServiceClient the live code uses -- narrow so tests can pass a fake. */
export type RoomsLike = Pick<RoomServiceClient, 'listRooms' | 'listParticipants' | 'removeParticipant'>;

// Built lazily so a box without LiveKit configured yet can still boot and
// serve every other route -- only /live/* itself fails until it's set up.
let _rooms: RoomServiceClient | undefined;
export const rooms = () => (_rooms ??= new RoomServiceClient(LK.host, LK.key, LK.secret));
