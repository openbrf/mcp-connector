import type { EntitlementState } from "./host-contract.ts";

/**
 * What the connector's screen shows the board about its licence.
 *
 * The host judges the licence (ADR 0042) and the connector passes the finding
 * on whole, so the screen and the instance's licence screen cannot disagree
 * about it. What the connector adds is when an active licence ends, counted on
 * the calendar day the host judges by, and who to get a licence from.
 */

/** The route the screen reads, under the connector's mount. */
export const STATUS_PATH = "status";

/**
 * How many days before an active licence ends the screen says when.
 *
 * ADR 0042: from thirty days before `validUntil`, the licence screen and the
 * module's own screen say when it ends.
 */
export const ENDING_NOTICE_DAYS = 30;

/** Who issues the connector's licence, as the manifest names them. */
export interface LicenceIssuer {
  readonly name: string;
  readonly url: string;
}

/** What `GET /api/plugin/mcp-connector/status` answers. */
export interface ConnectorStatus {
  /**
   * Whether the host has what the connector reads to serve a client: the
   * licence finding and `actions.client`. A host without either is older than
   * the connector, which serves no client there whatever the licence says.
   */
  readonly hostSupported: boolean;
  /** The host's finding on the licence, or null on a host that judges none. */
  readonly licence: EntitlementState | null;
  /**
   * The days from today to the last day of an active licence that ends within
   * the notice period: 0 when today is that day. Null otherwise, including for
   * a licence with no end.
   */
  readonly endsInDays: number | null;
  readonly issuer: LicenceIssuer;
}

export function connectorStatus(input: {
  hostSupported: boolean;
  licence: EntitlementState | null;
  today: string;
  issuer: LicenceIssuer;
}): ConnectorStatus {
  const { hostSupported, licence, today, issuer } = input;
  return {
    hostSupported,
    licence,
    endsInDays: endsInDays(licence, today),
    issuer,
  };
}

/**
 * Days left of an active licence, within the notice period.
 *
 * `validUntil` is inclusive, so a licence is active through the whole of that
 * day. A date that does not read as one gives null rather than a count: the
 * host's finding still stands, and the screen shows the date as it came.
 */
function endsInDays(
  licence: EntitlementState | null,
  today: string,
): number | null {
  if (licence?.status !== "active" || licence.validUntil === null) {
    return null;
  }
  const end = dayNumber(licence.validUntil);
  const now = dayNumber(today);
  if (end === null || now === null) {
    return null;
  }
  const left = end - now;
  return left >= 0 && left <= ENDING_NOTICE_DAYS ? left : null;
}

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` date as a count of days, or null if it is not one. */
function dayNumber(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  // Date.UTC rolls 2027-02-30 over into March rather than refusing it.
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return time / DAY_MS;
}

/**
 * Today's date in Sweden, `YYYY-MM-DD`.
 *
 * The host judges a licence on the association's calendar day, which is
 * Stockholm's, so the count of days left is made on the same one. On the
 * server's own day the count would be a day off around midnight for a server
 * running on UTC.
 */
export function stockholmToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
