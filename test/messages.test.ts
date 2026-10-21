import { describe, expect, it } from "vitest";

import { languageOf, translate } from "../src/messages.ts";

describe("the connector's own sentences", () => {
  it.each([
    ["en-US,en;q=0.9", "en"],
    ["EN", "en"],
    ["en_GB.UTF-8", "en"],
    ["sv-SE,sv;q=0.9,en;q=0.8", "sv"],
    ["de-DE", "sv"],
    ["*", "sv"],
    ["", "sv"],
    [null, "sv"],
    [undefined, "sv"],
  ] as const)("reads %j as %s", (tag, language) => {
    expect(languageOf(tag)).toBe(language);
  });

  it("fills in the values and picks the plural by the language's rules", () => {
    expect(
      translate("en", "cli.packageCheckPasses", { tarball: "a.tgz", count: 1 }),
    ).toBe("a.tgz: the package check passes (1 file).");
    expect(
      translate("sv", "cli.packageCheckPasses", { tarball: "a.tgz", count: 7 }),
    ).toBe("a.tgz: paketkontrollen godkänner paketet (7 filer).");
  });

  it("answers a sentence in each language", () => {
    expect(translate("en", "errors.unknownTool")).toBe("Unknown tool.");
    expect(translate("sv", "errors.unknownTool")).toBe("Okänt verktyg.");
  });
});
