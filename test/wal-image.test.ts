import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { walImage } from "../src/sqlite/wal-image.js";
import { tempDir } from "./sqlite-support.js";

const FRAME_HEADER = 24;
const WAL_HEADER = 32;

/** The rows of `t` in an in-memory copy of `image`. */
function rows(image: Uint8Array): number[] {
  const copy = new Uint8Array(image);
  copy.fill(1, 18, 20);
  const db = new DatabaseSync(":memory:");
  try {
    db.deserialize(copy);
    const all = db.prepare("SELECT x FROM t ORDER BY x").all() as { x: number }[];
    return all.map((row) => row.x);
  } finally {
    db.close();
  }
}

describe("walImage", () => {
  let dir: ReturnType<typeof tempDir>;
  let path: string;
  let writer: DatabaseSync;
  let pageSize: number;
  beforeEach(() => {
    dir = tempDir();
    path = join(dir.path, "w.db");
    writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec("CREATE TABLE t (x INTEGER) STRICT; INSERT INTO t VALUES (1);");
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // Two commits that stay in the WAL while the writer holds the file open.
    writer.exec("INSERT INTO t VALUES (2)");
    writer.exec("INSERT INTO t VALUES (3)");
    pageSize = (writer.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  });
  afterEach(() => {
    writer.close();
    dir.remove();
  });

  const files = () => ({ main: readFileSync(path), wal: readFileSync(`${path}-wal`) });

  test("replays every committed frame over the main file (positive control)", () => {
    const { main, wal } = files();
    expect(rows(main)).toEqual([1]);
    expect(rows(walImage(main, wal) as Uint8Array)).toEqual([1, 2, 3]);
  });

  test("a torn last frame drops only the commit it belonged to", () => {
    const { main, wal } = files();
    const torn = wal.subarray(0, wal.length - 10);
    expect(rows(walImage(main, torn) as Uint8Array)).toEqual([1, 2]);
  });

  test("a frame whose checksum fails ends the replay there", () => {
    const { main, wal } = files();
    const corrupt = Buffer.from(wal);
    const lastFrame = corrupt.length - (FRAME_HEADER + pageSize);
    corrupt[lastFrame + FRAME_HEADER + 100] = (corrupt[lastFrame + FRAME_HEADER + 100] ?? 0) ^ 0xff;
    expect(rows(walImage(main, corrupt) as Uint8Array)).toEqual([1, 2]);
  });

  test("an empty WAL, or one whose header checksum fails, leaves the main file", () => {
    const { main, wal } = files();
    expect(rows(walImage(main, new Uint8Array()) as Uint8Array)).toEqual([1]);
    const badHeader = Buffer.from(wal);
    badHeader.writeUInt32BE((badHeader.readUInt32BE(24) ^ 1) >>> 0, 24);
    expect(rows(walImage(main, badHeader) as Uint8Array)).toEqual([1]);
    expect(wal.length).toBeGreaterThan(WAL_HEADER);
  });

  test("an unknown magic is malformed, not empty", () => {
    const { main, wal } = files();
    const bad = Buffer.from(wal);
    bad.writeUInt32BE(0xdeadbeef, 0);
    expect(walImage(main, bad)).toBeUndefined();
  });

  // The database header writes a 64 KiB page as 1, since 65536 does not fit its two bytes; the
  // WAL header's field has four bytes and holds the size itself.
  test("a page size field of 1 is malformed, even under a valid header checksum", () => {
    const { main, wal } = files();
    /** SQLite's checksum of the first 24 header bytes, in the byte order the magic names. */
    const headerChecksum = (header: Buffer) => {
      const bigEndian = header.readUInt32BE(0) === 0x377f0683;
      const word = (at: number) => (bigEndian ? header.readUInt32BE(at) : header.readUInt32LE(at));
      let s0 = 0;
      let s1 = 0;
      for (let i = 0; i < 24; i += 8) {
        s0 = (s0 + word(i) + s1) >>> 0;
        s1 = (s1 + word(i + 4) + s0) >>> 0;
      }
      return [s0, s1];
    };
    // Positive control: over the real header it reproduces the checksum SQLite wrote.
    expect(headerChecksum(wal)).toEqual([wal.readUInt32BE(24), wal.readUInt32BE(28)]);
    const bad = Buffer.from(wal);
    bad.writeUInt32BE(1, 8);
    const [s0 = 0, s1 = 0] = headerChecksum(bad);
    bad.writeUInt32BE(s0, 24);
    bad.writeUInt32BE(s1, 28);
    expect(walImage(main, bad)).toBeUndefined();
  });
});

test("a 64 KiB page WAL names 65536 in its header and replays", () => {
  const dir = tempDir();
  const path = join(dir.path, "big.db");
  const writer = new DatabaseSync(path);
  try {
    writer.exec(
      "PRAGMA page_size = 65536; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;",
    );
    writer.exec("CREATE TABLE t (x INTEGER) STRICT; INSERT INTO t VALUES (1), (2);");
    const main = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    expect(main.readUInt16BE(16)).toBe(1);
    expect(wal.readUInt32BE(8)).toBe(65_536);
    const image = walImage(main, wal) as Uint8Array;
    expect(image.length % 65_536).toBe(0);
    expect(rows(image)).toEqual([1, 2]);
  } finally {
    writer.close();
    dir.remove();
  }
});
