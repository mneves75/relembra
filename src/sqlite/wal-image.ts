/**
 * The database as its committed WAL frames leave it, built in memory from the bytes of the main
 * file and the -wal file, without opening either for writing. Follows the WAL format
 * (https://www.sqlite.org/fileformat2.html#walformat): a frame counts only while its salts match
 * the header and its cumulative checksum holds, and only frames up to the last commit frame
 * apply. Undefined for an unknown magic or a bad page size, which SQLite would ignore as an empty
 * WAL: relembra refuses to guess. An empty or stale WAL yields the main file.
 */
export function walImage(main: Uint8Array, wal: Uint8Array): Uint8Array | undefined {
  if (wal.length < WAL_HEADER) return main;
  const header = new DataView(wal.buffer, wal.byteOffset, WAL_HEADER);
  const magic = header.getUint32(0);
  if (magic !== MAGIC_LITTLE && magic !== MAGIC_BIG) return undefined;
  const bigEndian = magic === MAGIC_BIG;
  const pageSize = header.getUint32(8);
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) return undefined;
  const salt = [header.getUint32(16), header.getUint32(20)];
  let sum = checksum(wal.subarray(0, 24), bigEndian, [0, 0]);
  if (sum[0] !== header.getUint32(24) || sum[1] !== header.getUint32(28)) return main;

  const pages = new Map<number, Uint8Array>();
  let committed = new Map<number, Uint8Array>();
  let committedSize: number | undefined;
  for (let offset = WAL_HEADER; offset + FRAME_HEADER + pageSize <= wal.length; ) {
    const frame = new DataView(wal.buffer, wal.byteOffset + offset, FRAME_HEADER);
    if (frame.getUint32(8) !== salt[0] || frame.getUint32(12) !== salt[1]) break;
    const data = wal.subarray(offset + FRAME_HEADER, offset + FRAME_HEADER + pageSize);
    sum = checksum(wal.subarray(offset, offset + 8), bigEndian, sum);
    sum = checksum(data, bigEndian, sum);
    if (sum[0] !== frame.getUint32(16) || sum[1] !== frame.getUint32(20)) break;
    pages.set(frame.getUint32(0), data);
    const sizeAfterCommit = frame.getUint32(4);
    if (sizeAfterCommit !== 0) {
      committed = new Map(pages);
      committedSize = sizeAfterCommit;
    }
    offset += FRAME_HEADER + pageSize;
  }
  if (committedSize === undefined) return main;

  const image = new Uint8Array(committedSize * pageSize);
  image.set(main.subarray(0, Math.min(main.length, image.length)));
  for (const [page, data] of committed) {
    if (page >= 1 && page <= committedSize) image.set(data, (page - 1) * pageSize);
  }
  return image;
}

const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const MAGIC_LITTLE = 0x377f0682;
const MAGIC_BIG = 0x377f0683;

/** SQLite's WAL checksum over 32-bit words in the byte order the magic names, continuing `start`. */
function checksum(bytes: Uint8Array, bigEndian: boolean, start: readonly number[]): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let s0 = start[0] ?? 0;
  let s1 = start[1] ?? 0;
  for (let i = 0; i + 8 <= bytes.length; i += 8) {
    s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0;
    s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0;
  }
  return [s0, s1];
}
