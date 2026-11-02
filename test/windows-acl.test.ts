/**
 * The access-list rules a Windows store folder's parent chain must meet before relembra secures the
 * folder by path (docs/specs/w-nv1/spec.md). The rules are pure, so these tests run everywhere; the
 * Windows tests in sqlite-windows-acl.test.ts read real access lists with icacls.
 */
import { describe, expect, test } from "bun:test";
import { chainRefusal, parseDacl, trustedAccounts } from "../src/sqlite/windows-acl.js";

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

const chain = (parent: string, ...above: string[]) => [
  { path: "C:\\Users\\me\\AppData", dacl: parent, holdsStoreFolder: true },
  ...above.map((dacl, i) => ({ path: `C:\\up${i}`, dacl, holdsStoreFolder: false })),
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

  test("a null DACL and an empty one differ", () => {
    expect(parseDacl("D:NO_ACCESS_CONTROL")).toBeNull();
    expect(parseDacl("D:P")).toEqual([]);
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
    expect(chainRefusal(chain(dacl), trustedAccounts("S-1-5-21-1-2-3-500"))).toBeUndefined();
    expect(chainRefusal(chain(dacl), TRUSTED)).toMatch(/\(LA\) /);
  });

  test("OWNER RIGHTS is another account: the owner is not read", () => {
    expect(chainRefusal(chain(PROFILE, "D:(A;;WD;;;OW)"), TRUSTED)).toMatch(/\(S-1-3-4\)/);
  });
});
