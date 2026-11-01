import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CandidateProcess } from "../eval/transport.js";

const FAULTY = join(import.meta.dir, "eval-faulty-candidate.ts");
const started: CandidateProcess[] = [];

function candidate(mode: string, options = {}): CandidateProcess {
  const process_ = new CandidateProcess([process.execPath, FAULTY, mode], options);
  started.push(process_);
  return process_;
}

const request = (id: string) => JSON.stringify({ v: 1, id, cmd: "reset", args: {} });

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first match of `pattern` in the fixture's stderr, waited for before any timed exchange:
 * under load a fixture can take longer to start than an exchange deadline, and a test must not
 * race its own fixture. The bound is generous; reaching it fails the test.
 */
async function stderrMatch(
  c: CandidateProcess,
  pattern: RegExp,
  boundMs = 20_000,
): Promise<RegExpExecArray> {
  const deadline = performance.now() + boundMs;
  for (;;) {
    const match = pattern.exec(c.stderr.tail);
    if (match) return match;
    if (performance.now() > deadline) throw new Error(`no ${pattern} on stderr in ${boundMs} ms`);
    await Bun.sleep(10);
  }
}

/** The pid the spawn-child fixtures print as `child <pid>`. */
async function childPid(c: CandidateProcess): Promise<number> {
  const [, pid] = await stderrMatch(c, /child (\d+)\n/);
  return Number(pid);
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.close(200)));
});

describe("CandidateProcess", () => {
  test("exchanges one line per request (positive control)", async () => {
    const c = candidate("echo");
    const first = await c.exchange(request("r1"), 5000);
    const second = await c.exchange(request("r2"), 5000);
    expect(first).toEqual({
      status: "line",
      line: '{"id":"r1","ok":true,"result":{"echo":"reset"}}',
    });
    expect(second.status).toBe("line");
    expect(c.alive).toBe(true);
  });

  test("a hung candidate is killed at its deadline", async () => {
    const c = candidate("hang");
    const began = performance.now();
    const outcome = await c.exchange(request("r1"), 300);
    expect(outcome.status).toBe("timeout");
    expect(performance.now() - began).toBeLessThan(2000);
    // Dead at once, not when the exit is reported: the next request must not reach it.
    expect(c.alive).toBe(false);
    await c.close(200);
    expect(c.alive).toBe(false);
  });

  test("a partial line is a timeout that keeps what was written", async () => {
    const c = candidate("partial");
    await stderrMatch(c, /ready\n/);
    expect(await c.exchange(request("r1"), 1000)).toEqual({ status: "timeout", partial: '{"id":' });
  });

  test("a line over the size limit is refused and the candidate killed", async () => {
    const c = candidate("oversize", { maxLineBytes: 64 * 1024 });
    const outcome = await c.exchange(request("r1"), 5000);
    expect(outcome.status).toBe("oversize");
    if (outcome.status === "oversize") expect(outcome.partial.length).toBe(64 * 1024);
    expect(c.alive).toBe(false);
  });

  test("an exiting candidate is reported, not awaited", async () => {
    const c = candidate("exit");
    const outcome = await c.exchange(request("r1"), 5000);
    expect(outcome.status).toBe("exit");
    expect((await c.exchange(request("r2"), 5000)).status).toBe("exit");
  });

  test("stderr is drained into a bounded tail", async () => {
    const c = candidate("stderr-flood", { stderrBytes: 1024 });
    expect((await c.exchange(request("r1"), 5000)).status).toBe("line");
    await c.close(200);
    expect(c.stderr.tail.length).toBe(1024);
    expect(c.stderr.totalBytes).toBe(200 * 1024);
  });

  test("stderr bytes are counted as written, invalid UTF-8 included", async () => {
    const c = candidate("stderr-invalid-utf8");
    expect((await c.exchange(request("r1"), 5000)).status).toBe("line");
    await c.close(200);
    expect(c.stderr.totalBytes).toBe(2);
  });

  test("close kills a candidate that ignores end of input", async () => {
    const c = candidate("ignore-eof");
    expect((await c.exchange(request("r1"), 5000)).status).toBe("line");
    const began = performance.now();
    await c.close(200);
    expect(performance.now() - began).toBeLessThan(2000);
    expect(c.alive).toBe(false);
  });

  test("a kill reaches processes the candidate started", async () => {
    const c = candidate("spawn-child");
    const pid = await childPid(c);
    expect(pid).toBeGreaterThan(0);
    // Positive control: the child runs before the kill.
    expect(running(pid)).toBe(true);
    const outcome = await c.exchange(request("r1"), 500);
    expect(outcome.status).toBe("timeout");
    await c.close(200);
    for (let i = 0; i < 50 && running(pid); i++) await Bun.sleep(20);
    expect(running(pid)).toBe(false);
  });

  test("a candidate whose leader exits leaves no child running, and close does not hang", async () => {
    const c = candidate("orphan-child");
    const pid = await childPid(c);
    expect(pid).toBeGreaterThan(0);
    // Positive control: the child runs before the kill.
    expect(running(pid)).toBe(true);
    const outcome = await c.exchange(request("r1"), 500);
    expect(outcome.status).toBe("timeout");
    const closed = await Promise.race([
      c.close(200).then(() => "closed"),
      Bun.sleep(3000).then(() => "hung"),
    ]);
    for (let i = 0; i < 50 && running(pid); i++) await Bun.sleep(20);
    const survived = running(pid);
    if (survived) process.kill(pid, "SIGKILL");
    expect(closed).toBe("closed");
    expect(survived).toBe(false);
  });

  test("lines no request asked for kill the candidate at once, and are never queued", async () => {
    const c = candidate("unsolicited-flood", { maxLineBytes: 1024 });
    const first = await c.exchange(request("r1"), 5000);
    expect(first).toEqual({
      status: "line",
      line: '{"id":"r1","ok":true,"result":{"echo":"reset"}}',
    });
    // The first unasked line kills it; nothing waits for a request to notice.
    for (let i = 0; i < 1000 && c.alive; i++) await Bun.sleep(10);
    expect(c.alive).toBe(false);
    const next = await c.exchange(request("r2"), 5000);
    expect(next).toEqual({ status: "unsolicited", partial: "u".repeat(127) });
  }, 20_000);

  test("a line before the first request is unsolicited too", async () => {
    const c = candidate("early-line");
    for (let i = 0; i < 2000 && c.alive; i++) await Bun.sleep(10);
    expect(c.alive).toBe(false);
    expect(await c.exchange(request("r1"), 5000)).toEqual({
      status: "unsolicited",
      partial: '{"id":"unasked","ok":true,"result":{}}',
    });
  }, 30_000);

  test("a command that cannot run is an exit, not a crash", async () => {
    const c = new CandidateProcess(["/nonexistent/relembra-candidate"]);
    started.push(c);
    expect((await c.exchange(request("r1"), 5000)).status).toBe("exit");
  });
});
