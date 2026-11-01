import { describe, expect, test } from "bun:test";
import { exposes, exposesText } from "../eval/exposure.js";

const memory = { id: "mem-000002", text: "Deploys pause on Fridays.", canary: "CANARY7Q" };

describe("exposure through character references", () => {
  test("a plain rendering of the id is exposed and an unrelated one is not (controls)", () => {
    expect(exposes('<index id="mem-000002"/>', memory)).toBe(true);
    expect(exposes('<index id="mem-000003"/>', memory)).toBe(false);
    expect(exposes("<wake>\n</wake>", memory)).toBe(false);
  });

  const encodedIds: Record<string, string> = {
    decimal: '<index id="&#109;em-000002"/>',
    hex: '<index id="&#x6d;em-000002"/>',
    "upper hex": '<index id="&#X6D;&#X65;m-000002"/>',
    "every character": `<index id="${[..."mem-000002"].map((c) => `&#${c.codePointAt(0)};`).join("")}"/>`,
    "named amp around a reference": '<index id="&amp;#109;em-000002"/>',
  };
  for (const [name, haystack] of Object.entries(encodedIds)) {
    test(`an id encoded with ${name} character references is exposed`, () => {
      expect(exposes(haystack, memory)).toBe(true);
    });
  }

  test("an encoded id that decodes to another id is not exposed (control)", () => {
    expect(exposes('<index id="&#109;em-000003"/>', memory)).toBe(false);
  });

  test("text encoded with named and numeric references is exposed", () => {
    const quoted = { id: "m-q", text: `It's "quoted" & <tagged>.` };
    const encoded = "It&apos;s &quot;quoted&quot; &amp; &lt;tagged&gt;.";
    expect(exposesText(encoded, quoted)).toBe(true);
    expect(exposesText("&#68;eploys pause on Fridays.", memory)).toBe(true);
    expect(exposesText("&#x43;ANARY7Q", memory)).toBe(true);
    // Control: text that decodes to something else is not exposed.
    expect(exposesText("&#69;eploys pause on Fridays.", memory)).toBe(false);
  });
});

describe("exposure through whitespace", () => {
  test("text wrapped or spaced differently is exposed; a word changed is not (control)", () => {
    const separators = [
      "\n",
      "\r\n",
      "\t",
      "  ",
      String.fromCodePoint(0x85),
      String.fromCodePoint(0x2028),
    ];
    for (const gap of separators) {
      expect(exposesText(`Deploys${gap}pause on Fridays.`, memory)).toBe(true);
    }
    expect(exposesText("Deploys &#10;pause on Fridays.", memory)).toBe(true);
    expect(exposesText("Deploys\npause on Mondays.", memory)).toBe(false);
    expect(exposesText("Deployspause on Fridays.", memory)).toBe(false);
  });
});
