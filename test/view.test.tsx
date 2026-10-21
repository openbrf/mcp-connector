// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../locales/en.json";
import sv from "../locales/sv.json";
import type { EntitlementState } from "../src/host-contract.ts";
import type { ConnectorStatus } from "../src/status.ts";
import View, { endpointOf } from "../src/View.tsx";

/**
 * The screen as the host renders it: inside the host's i18next, with the
 * connector's translations merged under `plugin-mcp-connector`, reading the
 * connector's route and the instance's resource document on the same origin.
 */

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "sv",
    fallbackLng: "sv",
    ns: ["plugin-mcp-connector"],
    resources: {
      sv: { "plugin-mcp-connector": sv },
      en: { "plugin-mcp-connector": en },
    },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ISSUER = { name: "Apteo AB", url: "https://apteo.se" };

const ACTIVE: EntitlementState = {
  status: "active",
  licenceId: "lic-2026-0042",
  validUntil: "2027-11-30",
  updatesUntil: null,
};

const ADDRESS = "https://brf.example/api/plugin/mcp-connector/mcp";

interface Served {
  status?: Partial<ConnectorStatus> | number;
  resource?: unknown;
}

function serve({ status = {}, resource = { resource: ADDRESS } }: Served = {}) {
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "https://brf.example");
    if (url.pathname === "/api/plugin/mcp-connector/status") {
      return typeof status === "number"
        ? new Response("", { status })
        : Response.json({
            hostSupported: true,
            licence: ACTIVE,
            endsInDays: null,
            issuer: ISSUER,
            ...status,
          });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return typeof resource === "number"
        ? new Response("", { status: resource })
        : Response.json(resource);
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show() {
  return render(
    <I18nextProvider i18n={i18n}>
      <View />
    </I18nextProvider>,
  );
}

function facts(panel: HTMLElement): string[] {
  return within(panel)
    .queryAllByRole("term")
    .map((term) => `${term.textContent}: ${term.nextSibling?.textContent}`);
}

describe("the licence", () => {
  it("shows an active licence with its dates, and serves without a word about dormancy", async () => {
    serve();
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    expect(await within(panel).findByText("Licensen är aktiv.")).toBeTruthy();
    expect(facts(panel)).toEqual([
      "Giltig till och med: 2027-11-30",
      "Täcker versioner till och med: Alla versioner",
      "Licens-id: lic-2026-0042",
    ]);
    expect(within(panel).queryByText(/vilande/)).toBeNull();
    expect(within(panel).queryByRole("link")).toBeNull();
    // Dates and the id are register data, in the data face.
    expect(within(panel).getByText("lic-2026-0042").style.fontFamily).toBe(
      "var(--obrf-font-data)",
    );
    // What the licence leaves out is said in words, which are not.
    expect(within(panel).getByText("Alla versioner").style.fontFamily).toBe("");
  });

  it("says when an active licence ends, from thirty days before, and where to renew it", async () => {
    serve({ status: { endsInDays: 12 } });
    show();

    expect(
      await screen.findByText(
        "Licensen går ut om 12 dagar. Förnya den så att anslutna appar fortsätter att betjänas.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Skaffa en licens från Apteo AB" }),
    ).toBeTruthy();
    expect(screen.queryByText(/^Utan en aktiv licens är/)).toBeNull();
  });

  it("says so on the last day", async () => {
    serve({ status: { endsInDays: 0 } });
    show();

    expect(await screen.findByText(/^Licensen går ut i dag\./)).toBeTruthy();
  });

  it("says the connector is dormant without a licence, and where to get one", async () => {
    serve({ status: { licence: { status: "absent" } } });
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    expect(
      await within(panel).findByText(
        "Ingen licens för MCP Connector har lagts in.",
      ),
    ).toBeTruthy();
    expect(within(panel).getByText(/^Utan en aktiv licens är/)).toBeTruthy();
    expect(
      within(panel).getByText(
        "Styrelsen lägger in licensfilen på instansens licenssida.",
      ),
    ).toBeTruthy();
    const link = within(panel).getByRole("link", {
      name: "Skaffa en licens från Apteo AB",
    });
    expect(link.getAttribute("href")).toBe("https://apteo.se");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(facts(panel)).toEqual([]);
  });

  it.each<[EntitlementState, RegExp, string[]]>([
    [
      { status: "expired", licenceId: "lic-1", validUntil: "2026-09-30" },
      /^Licensen har gått ut\.$/,
      ["Giltig till och med: 2026-09-30", "Licens-id: lic-1"],
    ],
    [
      {
        status: "version-not-covered",
        licenceId: "lic-1",
        updatesUntil: "2026-06-30",
        released: "2026-10-20",
      },
      /^Den här versionen av MCP Connector kom ut efter/,
      [
        "Täcker versioner till och med: 2026-06-30",
        "Den här versionen: 2026-10-20",
        "Licens-id: lic-1",
      ],
    ],
    [
      { status: "wrong-instance", licenceId: "lic-1" },
      /^Licensen är utfärdad till en annan instans\.$/,
      ["Licens-id: lic-1"],
    ],
    [{ status: "tampered" }, /^Licensen går inte längre att verifiera\./, []],
    [
      { status: "not-yet-valid", licenceId: "lic-1", issuedOn: "2026-10-25" },
      /^Licensen är daterad efter i dag/,
      ["Utfärdad: 2026-10-25", "Licens-id: lic-1"],
    ],
  ])("shows the finding %#: %o", async (licence, finding, expected) => {
    serve({ status: { licence } });
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    expect(await within(panel).findByText(finding)).toBeTruthy();
    expect(facts(panel)).toEqual(expected);
    expect(within(panel).getByText(/^Utan en aktiv licens är/)).toBeTruthy();
  });

  it("asks for an update on an instance that judges no licence", async () => {
    serve({ status: { hostSupported: false, licence: null } });
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    expect(
      await within(panel).findByText(/^Instansen är äldre än MCP Connector/),
    ).toBeTruthy();
    // Entering a licence would change nothing there.
    expect(within(panel).queryByText(/licenssida/)).toBeNull();
    expect(within(panel).queryByRole("link")).toBeNull();
    expect(within(panel).queryByText(/^Utan en aktiv licens är/)).toBeNull();
  });

  it("asks for an update on an instance too old to serve, even with an active licence", async () => {
    serve({ status: { hostSupported: false } });
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    expect(
      await within(panel).findByText(/^Instansen är äldre än MCP Connector/),
    ).toBeTruthy();
    expect(within(panel).getByText("Licensen är aktiv.")).toBeTruthy();
    expect(within(panel).queryByText(/^Utan en aktiv licens är/)).toBeNull();
  });

  it("links to the issuer only over HTTPS", async () => {
    serve({
      status: {
        licence: { status: "absent" },
        issuer: { name: "Apteo AB", url: "javascript:alert(1)" },
      },
    });
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    await within(panel).findByText(/^Ingen licens/);
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("says so when the licence cannot be read", async () => {
    serve({ status: 403 });
    show();

    const panel = screen.getByRole("region", { name: "Licens" });
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "Licensen kunde inte läsas.",
    );
  });
});

describe("the address for MCP clients", () => {
  it("is the instance's protected resource, in the data face", async () => {
    const fetch = serve();
    show();

    const panel = screen.getByRole("region", {
      name: "Adress för MCP-klienter",
    });
    const address = await within(panel).findByText(ADDRESS);
    expect(address.tagName).toBe("CODE");
    expect(address.style.fontFamily).toBe("var(--obrf-font-data)");
    expect(fetch).toHaveBeenCalledWith(
      "/.well-known/oauth-protected-resource",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("is not offered while another plugin holds the instance's resource", async () => {
    serve({
      resource: { resource: "https://brf.example/api/plugin/other/mcp" },
    });
    show();

    const panel = screen.getByRole("region", {
      name: "Adress för MCP-klienter",
    });
    expect(
      await within(panel).findByText(
        /^Ett annat tillägg har instansens adress/,
      ),
    ).toBeTruthy();
    expect(within(panel).queryByText(/api\/plugin\/other/)).toBeNull();
  });

  it.each<[string, unknown]>([
    ["refused", 404],
    ["without a resource", { authorization_servers: [] }],
    ["with a resource that is not an address", { resource: "mcp" }],
  ])("says so when the document is %s", async (_, resource) => {
    serve({ resource });
    show();

    const panel = screen.getByRole("region", {
      name: "Adress för MCP-klienter",
    });
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "Adressen kunde inte läsas.",
    );
  });

  it("is read off the document by its path alone", () => {
    expect(
      endpointOf({
        resource: "https://brf.example:8443/api/plugin/mcp-connector/mcp",
      }),
    ).toEqual({
      holder: "connector",
      address: "https://brf.example:8443/api/plugin/mcp-connector/mcp",
    });
    expect(
      endpointOf({
        resource: "https://brf.example/api/plugin/mcp-connector/mcp/",
      }),
    ).toEqual({ holder: "other" });
  });
});

describe("the actions", () => {
  it("leads to the armed actions and the connected apps, with touch targets of 44px", async () => {
    serve();
    show();

    const panel = screen.getByRole("region", {
      name: "Vad anslutna appar får göra",
    });
    const armed = within(panel).getByRole("link", {
      name: "Aktiverade åtgärder, under Tillägg",
    });
    const apps = within(panel).getByRole("link", { name: "Anslutna appar" });
    expect(armed.getAttribute("href")).toBe("/app/plugins");
    expect(apps.getAttribute("href")).toBe("/app/connected-apps");
    for (const link of [armed, apps]) {
      expect(link.style.minHeight).toBe("44px");
    }
    await screen.findByText("Licensen är aktiv.");
  });
});

describe("the translations", () => {
  it("hold the same keys in both languages", () => {
    const paths = (tree: object, prefix = ""): string[] =>
      Object.entries(tree).flatMap(([name, value]) =>
        typeof value === "string"
          ? [`${prefix}${name}`]
          : paths(value as object, `${prefix}${name}.`),
      );
    expect(paths(en).toSorted()).toEqual(paths(sv).toSorted());
  });

  it("speak English when the person does", async () => {
    serve({ status: { licence: { status: "absent" } } });
    await i18n.changeLanguage("en");
    try {
      show();
      expect(
        await screen.findByText(
          "No licence for the connector has been entered.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Armed actions, under Plugins" }),
      ).toBeTruthy();
    } finally {
      await i18n.changeLanguage("sv");
    }
  });
});
