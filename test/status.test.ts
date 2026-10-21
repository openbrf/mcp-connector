import { describe, expect, it } from "vitest";

import type { EntitlementState } from "../src/host-contract.ts";
import {
  connectorStatus,
  ENDING_NOTICE_DAYS,
  stockholmToday,
} from "../src/status.ts";

const ISSUER = { name: "Apteo AB", url: "https://apteo.se" };

function activeUntil(validUntil: string | null): EntitlementState {
  return {
    status: "active",
    licenceId: "lic-1",
    validUntil,
    updatesUntil: null,
  };
}

function endsInDays(licence: EntitlementState | null, today: string) {
  return connectorStatus(licence, today, ISSUER).endsInDays;
}

describe("the status the screen reads", () => {
  it("passes the host's finding and the issuer on whole", () => {
    const licence: EntitlementState = {
      status: "expired",
      licenceId: "lic-1",
      validUntil: "2026-09-30",
    };
    expect(connectorStatus(licence, "2026-10-20", ISSUER)).toEqual({
      licence,
      endsInDays: null,
      issuer: ISSUER,
    });
  });

  it("is null for a host that cannot judge a licence", () => {
    expect(connectorStatus(null, "2026-10-20", ISSUER)).toEqual({
      licence: null,
      endsInDays: null,
      issuer: ISSUER,
    });
  });
});

describe("when an active licence ends", () => {
  it("is counted from thirty days before its last day", () => {
    expect(ENDING_NOTICE_DAYS).toBe(30);
    expect(endsInDays(activeUntil("2026-11-19"), "2026-10-20")).toBe(30);
    expect(endsInDays(activeUntil("2026-11-20"), "2026-10-20")).toBeNull();
  });

  it("is 0 on its last day, through which it is still active", () => {
    expect(endsInDays(activeUntil("2026-10-20"), "2026-10-20")).toBe(0);
  });

  it("counts across the end of February in a leap year", () => {
    expect(endsInDays(activeUntil("2028-03-01"), "2028-02-28")).toBe(2);
    expect(endsInDays(activeUntil("2028-02-29"), "2028-02-01")).toBe(28);
  });

  it("is not counted for a licence with no end", () => {
    expect(endsInDays(activeUntil(null), "2026-10-20")).toBeNull();
  });

  it("is not counted for a licence that is not active", () => {
    expect(
      endsInDays(
        { status: "not-yet-valid", licenceId: "lic-1", issuedOn: "2026-10-25" },
        "2026-10-20",
      ),
    ).toBeNull();
  });

  it("is not counted from a date that is not one", () => {
    for (const date of ["2026-02-30", "2027-02-29", "2026-1-05", "", " "]) {
      expect(endsInDays(activeUntil(date), "2026-01-20")).toBeNull();
    }
    expect(endsInDays(activeUntil("2026-10-21"), "20 October")).toBeNull();
  });
});

describe("today", () => {
  it("is Stockholm's day, which starts before UTC's", () => {
    // Summer time, UTC+2.
    expect(stockholmToday(new Date("2026-06-30T21:59:59Z"))).toBe("2026-06-30");
    expect(stockholmToday(new Date("2026-06-30T22:00:00Z"))).toBe("2026-07-01");
    // Winter time, UTC+1, across a year.
    expect(stockholmToday(new Date("2026-12-31T22:59:59Z"))).toBe("2026-12-31");
    expect(stockholmToday(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});
