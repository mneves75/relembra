/**
 * The access-list rules a Windows store folder's parent chain must meet before relembra secures the
 * folder by path (docs/specs/w-nv1/spec.md). The rules are pure, so these tests run everywhere; the
 * Windows tests in sqlite-windows-acl.test.ts read real access lists with icacls.
 */
import { describe, expect, test } from "bun:test";
import {
  chainRefusal,
  parseDacl,
  storeFolderChain,
  trustedAccounts,
} from "../src/sqlite/windows-acl.js";

const USER = "S-1-5-21-1-2-3-1001";
const TRUSTED = trustedAccounts(USER);

/** A profile folder as Windows makes it: the user, SYSTEM and Administrators, all inherited. */
const PROFILE = `D:P(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;
/** C:\Users: read for Users and Everyone, inherit-only read for what is made in it. */
const USERS =
  "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GRGX;;;BU)(A;;0x1200a9;;;WD)(A;OICIIO;GRGX;;;WD)";
/** C:\: Authenticated Users may add folders to it and get Modify on what they make. */
const ROOT =
  "D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICIIO;SDGXGWGR;;;AU)(A;;LC;;;AU)";
/**
 * C:\ on the windows-latest runner, as `icacls C:\ /save` wrote it (PR #7's first run): an app
 * container's read. icacls also wrote the mandatory label's SACL on the same line; the store reads
 * the access list alone (AccessControlSections::Access), so it is left out here.
 */
const RUNNER_ROOT =
  "D:AI(A;;0x1000a1;;;S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176)(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)";

const chain = (parent: string, ...above: string[]) => [
  { path: "C:\\Users\\me\\AppData", dacl: parent, ownerSid: USER, holdsStoreFolder: true },
  ...above.map((dacl, i) => ({
    path: `C:\\up${i}`,
    dacl,
    ownerSid: USER,
    holdsStoreFolder: false,
  })),
];

describe("parseDacl reads an SDDL access list", () => {
  test("letter rights, hex rights, flags and SID aliases", () => {
    expect(
      parseDacl("D:PAI(A;OICIIO;FA;;;SY)(D;;0x10000;;;S-1-5-32-545)(A;CI;RCSDWDWO;;;CO)"),
    ).toEqual([
      { allow: true, inheritOnly: true, containerInherit: true, mask: 0x1f01ff, sid: "S-1-5-18" },
      {
        allow: false,
        inheritOnly: false,
        containerInherit: false,
        mask: 0x10000,
        sid: "S-1-5-32-545",
      },
      { allow: true, inheritOnly: false, containerInherit: true, mask: 0xf0000, sid: "S-1-3-0" },
    ]);
  });

  test("a conditional entry's own parentheses do not end it", () => {
    expect(parseDacl("D:(XA;;FR;;;WD;(Member_of {SID(BA)}))(A;;FA;;;BA)")).toEqual([
      { allow: true, inheritOnly: false, containerInherit: false, mask: 0x120089, sid: "S-1-1-0" },
      {
        allow: true,
        inheritOnly: false,
        containerInherit: false,
        mask: 0x1f01ff,
        sid: "S-1-5-32-544",
      },
    ]);
  });

  test("the runner's drive root parses; text after the access list, a SACL included, is refused", () => {
    expect(parseDacl(RUNNER_ROOT)?.map((ace) => ace.sid)).toEqual([
      "S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176",
      "S-1-5-11",
      "S-1-5-11",
      "S-1-5-18",
      "S-1-5-32-544",
      "S-1-5-32-545",
    ]);
    expect(chainRefusal(chain(PROFILE, PROFILE, USERS, RUNNER_ROOT), TRUSTED)).toBeUndefined();
    // The store asks for the access list alone, so any other section is unexpected text.
    expect(() => parseDacl(`${RUNNER_ROOT}S:PAI(ML;OINPIO;NW;;;HI)`)).toThrow(/unexpected text/);
    expect(() => parseDacl("D:PS:PAI(ML;OINPIO;NW;;;HI)")).toThrow(/unexpected text/);
    expect(() => parseDacl("D:(A;;FA;;;BA)O:BA")).toThrow(/unexpected text/);
  });

  test("a null DACL and an empty one differ", () => {
    expect(parseDacl("D:NO_ACCESS_CONTROL")).toBeNull();
    expect(parseDacl("D:P")).toEqual([]);
  });

  test("a parenthesis inside a condition's quoted string does not end the entry", () => {
    // Sol's review of PR #7: counted naively, the first entry swallows the Users grant.
    const sddl = 'D:(XA;;FR;;;SY;(@User.Title=="("))(A;;FA;;;BU)(XA;;FR;;;SY;(@User.Title==")"))';
    expect(parseDacl(sddl)?.map((ace) => ace.sid)).toEqual([
      "S-1-5-18",
      "S-1-5-32-545",
      "S-1-5-18",
    ]);
    expect(chainRefusal(chain(sddl), TRUSTED)).toMatch(/\(S-1-5-32-545\)/);
    expect(parseDacl('D:(XA;;FR;;;SY;(@User.Title==";)("))')).toHaveLength(1);
  });

  test("quotes outside a condition, and a condition on a plain entry, are refused", () => {
    for (const sddl of [
      'D:(A;;FR;"(;;;SY)(A;;FA;;;BU)',
      "D:(A;;FR;;;SY;(@User.Title==1))",
      "D:(XA;;FR;;;SY;@User.Title==1)",
      'D:(XA;;FR;;;SY;(@User.Title=="x)',
      "D:(A;;FR;not-a-guid;;SY)",
    ]) {
      expect(() => parseDacl(sddl)).toThrow();
    }
    // A callback entry without a condition is an allow like any other.
    expect(parseDacl("D:(XA;;FA;;;BU)")?.[0]?.sid).toBe("S-1-5-32-545");
  });

  test("an unknown right, ACE type or shape is refused, never skipped", () => {
    for (const sddl of [
      "D:(A;;ZZ;;;BU)",
      "D:(Q;;FA;;;BU)",
      "D:(A;;FA;;BU)",
      "D:(A;;FA;;;BU",
      "O:BA",
      "D:(A;QQ;FA;;;BU)",
    ]) {
      expect(() => parseDacl(sddl)).toThrow();
    }
  });
});

describe("chainRefusal applies the four rules", () => {
  test("a foreign owner is refused even when its SID has no access entry", () => {
    const folders = chain(PROFILE, PROFILE, USERS, ROOT);
    expect(chainRefusal(folders, TRUSTED)).toBeUndefined();
    for (let index = 0; index < folders.length; index++) {
      const changed = folders.map((folder, i) => ({
        ...folder,
        ownerSid: i === index ? "S-1-5-21-9-8-7-1002" : folder.ownerSid,
      }));
      expect(chainRefusal(changed, TRUSTED)).toMatch(/owned by another account/);
    }
  });

  test("a missing or placeholder owner cannot attest the chain", () => {
    for (const ownerSid of ["", "S-1-3-0", "unknown"]) {
      expect(
        chainRefusal(
          chain(PROFILE).map((folder) => ({ ...folder, ownerSid })),
          TRUSTED,
        ),
      ).toMatch(/owner/);
    }
  });

  test("positive control: the default profile chain passes", () => {
    expect(chainRefusal(chain(PROFILE, PROFILE, USERS, ROOT), TRUSTED)).toBeUndefined();
  });

  test("trusted accounts and denials never refuse", () => {
    const dacl = `D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})(A;OICIIO;GA;;;CO)(A;OICI;FA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(D;OICI;FA;;;BU)`;
    expect(chainRefusal(chain(dacl), TRUSTED)).toBeUndefined();
  });

  test("R1: a foreign right to delete, re-permission or take any folder in the chain", () => {
    for (const right of ["SD", "WD", "WO", "GA", "0x10000"]) {
      const refusal = chainRefusal(chain(PROFILE, `D:(A;;${right};;;BU)`), TRUSTED);
      expect({ right, refusal }).toEqual({
        right,
        refusal: expect.stringMatching(
          /C:\\up0 .*S-1-5-32-545\) .*rename, delete or re-permission/,
        ),
      });
    }
  });

  test("R2: a foreign right to delete what any folder in the chain holds", () => {
    expect(chainRefusal(chain(PROFILE, PROFILE, "D:(A;;DT;;;AU)"), TRUSTED)).toMatch(
      /C:\\up1 .*S-1-5-11\) .*rename or delete the folders in it/,
    );
  });

  test("an attribute write or generic write can turn an empty ancestor into a reparse point", () => {
    for (const right of ["0x100", "GW"]) {
      expect(chainRefusal(chain(PROFILE, `D:(A;;${right};;;BU)`), TRUSTED)).toMatch(
        /attributes or turn it into a reparse point/,
      );
    }
  });

  test("R3: a foreign right to add folders, on the store folder's parent only", () => {
    expect(chainRefusal(chain(`${PROFILE}(A;;LC;;;BU)`), TRUSTED)).toMatch(
      /AppData .*S-1-5-32-545\) .*create the store folder/,
    );
    // The same right higher up is the drive root's default and refuses nothing.
    expect(chainRefusal(chain(PROFILE, "D:(A;;LC;;;BU)"), TRUSTED)).toBeUndefined();
  });

  test("R4: a foreign right beyond read, inherited by a new store folder", () => {
    expect(chainRefusal(chain(`${PROFILE}(A;OICIIO;SDGXGWGR;;;AU)`), TRUSTED)).toMatch(
      /AppData .*S-1-5-11\) .*open the new store folder/,
    );
    // Read and execute may be inherited; a right that subfolders do not inherit is not R4's.
    expect(
      chainRefusal(chain(`${PROFILE}(A;OICI;GRGX;;;WD)(A;OIIO;FA;;;BU)`), TRUSTED),
    ).toBeUndefined();
  });

  test("an inherit-only entry gives the folder itself nothing", () => {
    expect(chainRefusal(chain(PROFILE, "D:(A;OICIIO;FA;;;BU)"), TRUSTED)).toBeUndefined();
  });

  test("a null DACL is full control for Everyone", () => {
    expect(chainRefusal(chain(PROFILE, "D:NO_ACCESS_CONTROL"), TRUSTED)).toMatch(
      /C:\\up0 .*S-1-1-0/,
    );
  });

  test("the built-in Administrator account's alias is the user only when the user is that account", () => {
    const dacl = "D:(A;OICI;FA;;;LA)";
    const admin = "S-1-5-21-1-2-3-500";
    expect(
      chainRefusal(
        chain(dacl).map((folder) => ({ ...folder, ownerSid: admin })),
        trustedAccounts(admin),
      ),
    ).toBeUndefined();
    expect(chainRefusal(chain(dacl), TRUSTED)).toMatch(/\(LA\) /);
  });

  test("OWNER RIGHTS does not relax the conservative permission check", () => {
    expect(chainRefusal(chain(PROFILE, "D:(A;;WD;;;OW)"), TRUSTED)).toMatch(/\(S-1-3-4\)/);
  });
});

describe("storeFolderChain is the path as given, never its canonical form", () => {
  test("every folder from the store folder's parent to the root, short names kept", () => {
    // Sol's review of PR #7: reading the canonical path instead skips what lies on this one.
    expect(storeFolderChain("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\home")).toEqual([
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x",
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp",
      "C:\\Users\\RUNNER~1\\AppData\\Local",
      "C:\\Users\\RUNNER~1\\AppData",
      "C:\\Users\\RUNNER~1",
      "C:\\Users",
      "C:\\",
    ]);
  });

  test("a store folder at a drive root has no chain", () => {
    expect(storeFolderChain("D:\\")).toEqual([]);
    expect(storeFolderChain("D:\\home")).toEqual(["D:\\"]);
  });
});
