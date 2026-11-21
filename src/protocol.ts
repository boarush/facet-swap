import { v1 } from "./adapters/v1";
import { latest, LATEST, type VersionCodec } from "./contract";

// Supported protocol versions, registered here as pairs of pure adapters.
// Dropping a version deletes its adapter and its registry entry.
const versions = new Map<number, VersionCodec>([
  [latest.number, latest],
  [v1.number, v1],
]);

export { latest, LATEST };
export type { VersionCodec } from "./contract";

export const codecFor = (version: number): VersionCodec | undefined => versions.get(version);

export const supportedVersions = (): number[] => [...versions.keys()].sort((a, b) => b - a);

/**
 * Pick a protocol version once, at connect time (RFC 0010) from the `?v=`
 * query parameter on the handshake URL. There is no default: passing a
 * version is part of the contract, never an escape hatch. null means the
 * client sent no version or one this server no longer speaks; the caller
 * must reject the upgrade.
 */
export const negotiate = (query: string | null | undefined): number | null => {
  if (!query) return null;
  const version = Number(query);
  return versions.has(version) ? version : null;
};
