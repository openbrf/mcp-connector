import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

// Types only: a value imported from the server's modules would put them into
// the browser's bundle.
import type { EntitlementState } from "./host-contract.ts";
import type { ConnectorStatus } from "./status.ts";

/**
 * The connector's screen, exposed as `./View` and offered in the board's
 * section of the navigation.
 *
 * Three things the board needs to run the connector, each read from where it
 * is decided rather than kept here:
 *
 * - the licence, as the host judged it, from the connector's `status` route;
 * - the address a member gives their MCP client, from the instance's
 *   protected resource document, which is what every token is issued for;
 * - the way to the armed actions and the connected apps, which are the core's
 *   own screens.
 *
 * Every word is a key in `plugin-mcp-connector`, and every colour, radius and
 * typeface a `--obrf-*` token, inline because the host's stylesheet holds only
 * the utility classes the host uses.
 */

const NAMESPACE = "plugin-mcp-connector";

const BASE = "/api/plugin/mcp-connector";

/** Where the host mounts the connector's MCP route. */
export const RESOURCE_PATH = `${BASE}/mcp`;

/** The instance's protected resource document (RFC 9728). */
const RESOURCE_DOCUMENT = "/.well-known/oauth-protected-resource";

/** The core's screens this one links to, under the application's base path. */
const PLUGINS_SCREEN = "/app/plugins";
const CONNECTED_APPS_SCREEN = "/app/connected-apps";

type Loaded<T> =
  { status: "loading" } | { status: "failed" } | { status: "ready"; data: T };

/**
 * Reads one JSON document from the instance, once.
 *
 * Same origin, so the session cookie travels with the request and the view
 * never handles a credential. A refusal is shown as the same failure as any
 * other: the route says who may read it, not the screen.
 */
function useJson<T>(url: string, read: (body: unknown) => T): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        const data = read(await response.json());
        if (!controller.signal.aborted) {
          setState({ status: "ready", data });
        }
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: "failed" });
        }
      }
    };

    void load();
    return () => {
      controller.abort();
    };
    // `read` is left out: every caller passes a module-level function.
  }, [url]);

  return state;
}

function readStatus(body: unknown): ConnectorStatus {
  return body as ConnectorStatus;
}

/** Who answers on the instance's address for MCP clients. */
export type Endpoint =
  { holder: "connector"; address: string } | { holder: "other" };

/**
 * The address a client is to be given, read off the resource document.
 *
 * At most one installed plugin holds the instance's protected resource. When
 * another one does, the document names its route, and a client given the
 * instance's address reaches that plugin instead. A document without a
 * resource address is not one this screen can read.
 */
export function endpointOf(body: unknown): Endpoint {
  const resource =
    typeof body === "object" && body !== null
      ? (body as { resource?: unknown }).resource
      : undefined;
  if (typeof resource !== "string") {
    throw new TypeError("The document names no resource.");
  }
  const url = new URL(resource);
  return url.pathname === RESOURCE_PATH
    ? { holder: "connector", address: resource }
    : { holder: "other" };
}

const styles = {
  page: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
    fontFamily: "var(--obrf-font-ui)",
    color: "var(--obrf-text-primary)",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1.25rem",
    background: "var(--obrf-surface-raised)",
    border: "1px solid var(--obrf-border-subtle)",
    borderRadius: "var(--obrf-radius-panel)",
    boxShadow: "var(--obrf-shadow-raised)",
  },
  title: { margin: 0, fontSize: "1.25rem", fontWeight: 600 },
  heading: { margin: 0, fontSize: "1.0625rem", fontWeight: 600 },
  text: { margin: 0, fontSize: "0.9375rem" },
  muted: {
    margin: 0,
    fontSize: "0.8125rem",
    color: "var(--obrf-text-secondary)",
  },
  failed: {
    margin: 0,
    fontSize: "0.8125rem",
    color: "var(--obrf-status-danger)",
  },
  // Text stays on the raised surface, the pair a theme's contrast check
  // guarantees; the status colour is the bar beside it.
  finding: {
    margin: 0,
    padding: "0.25rem 0.75rem",
    fontSize: "0.9375rem",
    fontWeight: 600,
    borderLeft: "3px solid var(--obrf-status-warn)",
  },
  findingActive: { borderLeftColor: "var(--obrf-status-ok)" },
  attention: {
    margin: 0,
    padding: "0.25rem 0.75rem",
    fontSize: "0.8125rem",
    borderLeft: "3px solid var(--obrf-status-warn)",
  },
  facts: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: "0.25rem 1rem",
    margin: 0,
    fontSize: "0.875rem",
  },
  factLabel: { color: "var(--obrf-text-secondary)" },
  factValue: { margin: 0, fontFamily: "var(--obrf-font-data)" },
  address: {
    display: "block",
    padding: "0.5rem 0.75rem",
    fontFamily: "var(--obrf-font-data)",
    fontSize: "0.9375rem",
    overflowWrap: "anywhere",
    background: "var(--obrf-surface-page)",
    border: "1px solid var(--obrf-border-strong)",
    borderRadius: "var(--obrf-radius-control)",
    userSelect: "all",
  },
  links: { display: "flex", flexWrap: "wrap", gap: "0.5rem 1.25rem" },
  // At least 44px tall, the smallest touch target the design system allows.
  link: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "44px",
    fontSize: "0.9375rem",
    color: "var(--obrf-accent-trust)",
  },
} satisfies Record<string, CSSProperties>;

function Panel({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section style={styles.panel} aria-labelledby={id}>
      <h3 id={id} style={styles.heading}>
        {heading}
      </h3>
      {children}
    </section>
  );
}

/**
 * One label and its value. A date or an id is register data, in the data
 * face; a value the licence leaves out is said in words, in the interface's.
 */
interface FactRow {
  label: string;
  value: string | null;
  none?: string;
}

function Fact({ label, value, none }: FactRow): ReactElement {
  return (
    <>
      <dt style={styles.factLabel}>{label}</dt>
      {value === null ? (
        <dd style={{ margin: 0 }}>{none}</dd>
      ) : (
        <dd style={styles.factValue}>{value}</dd>
      )}
    </>
  );
}

/** The dates and id the host's finding carries, under their labels. */
function LicenceFacts({
  licence,
}: {
  licence: EntitlementState;
}): ReactElement | null {
  const { t } = useTranslation(NAMESPACE);
  const facts: [string, string | null, string?][] = [];
  switch (licence.status) {
    case "active":
      facts.push(
        [
          t("view.licence.validUntil"),
          licence.validUntil,
          t("view.licence.noEnd"),
        ],
        [
          t("view.licence.updatesUntil"),
          licence.updatesUntil,
          t("view.licence.everyRelease"),
        ],
      );
      break;
    case "expired":
      facts.push([t("view.licence.validUntil"), licence.validUntil]);
      break;
    case "version-not-covered":
      facts.push(
        [t("view.licence.updatesUntil"), licence.updatesUntil],
        [t("view.licence.released"), licence.released],
      );
      break;
    case "not-yet-valid":
      facts.push([t("view.licence.issuedOn"), licence.issuedOn]);
      break;
    case "absent":
    case "wrong-instance":
    case "tampered":
      break;
  }
  if ("licenceId" in licence) {
    facts.push([t("view.licence.id"), licence.licenceId]);
  }
  if (facts.length === 0) {
    return null;
  }
  return (
    <dl style={styles.facts}>
      {facts.map(([label, value, none]) => (
        <Fact key={label} label={label} value={value} none={none} />
      ))}
    </dl>
  );
}

function Licence({ status }: { status: ConnectorStatus }): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  const { hostSupported, licence, endsInDays, issuer } = status;
  const active = licence?.status === "active";
  /*
   * Where to get a licence is said when the board needs a new one: none is
   * active, or the active one is about to end. An instance that judges no
   * licence is helped only by an update, so it is not said there.
   */
  const needsLicence = licence !== null && (!active || endsInDays !== null);

  return (
    <>
      {hostSupported ? null : (
        <p style={styles.finding}>{t("view.licence.hostUnsupported")}</p>
      )}
      {licence === null ? null : (
        <>
          <p
            style={
              active
                ? { ...styles.finding, ...styles.findingActive }
                : styles.finding
            }
          >
            {t(`view.licence.status.${licence.status}`)}
          </p>
          <LicenceFacts licence={licence} />
        </>
      )}
      {endsInDays === null ? null : (
        <p style={styles.attention}>
          {endsInDays === 0
            ? t("view.licence.endsToday")
            : t("view.licence.endsIn", { count: endsInDays })}
        </p>
      )}
      {licence === null || active ? null : (
        <p style={styles.text}>{t("view.licence.dormant")}</p>
      )}
      {needsLicence ? (
        <>
          <p style={styles.muted}>{t("view.licence.enter")}</p>
          {/^https:\/\//.test(issuer.url) ? (
            <div style={styles.links}>
              <a
                href={issuer.url}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.link}
              >
                {t("view.licence.issuer", { name: issuer.name })}
              </a>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Address(): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  const endpoint = useJson(RESOURCE_DOCUMENT, endpointOf);

  switch (endpoint.status) {
    case "loading":
      return <p style={styles.muted}>{t("view.loading")}</p>;
    case "failed":
      return (
        <p role="alert" style={styles.failed}>
          {t("view.address.error")}
        </p>
      );
    case "ready":
      return endpoint.data.holder === "connector" ? (
        <>
          <code style={styles.address}>{endpoint.data.address}</code>
          <p style={styles.muted}>{t("view.address.hint")}</p>
        </>
      ) : (
        <p style={styles.attention}>{t("view.address.otherHolder")}</p>
      );
  }
}

export default function McpConnectorView(): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  const status = useJson(`${BASE}/status`, readStatus);

  return (
    <div style={styles.page}>
      <h2 style={styles.title}>{t("view.title")}</h2>
      <p style={styles.text}>{t("view.intro")}</p>

      <Panel id="mcp-connector-licence" heading={t("view.licence.heading")}>
        {status.status === "loading" ? (
          <p style={styles.muted}>{t("view.loading")}</p>
        ) : null}
        {status.status === "failed" ? (
          <p role="alert" style={styles.failed}>
            {t("view.licence.error")}
          </p>
        ) : null}
        {status.status === "ready" ? <Licence status={status.data} /> : null}
      </Panel>

      <Panel id="mcp-connector-address" heading={t("view.address.heading")}>
        <Address />
      </Panel>

      <Panel id="mcp-connector-actions" heading={t("view.actions.heading")}>
        <p style={styles.text}>{t("view.actions.body")}</p>
        <div style={styles.links}>
          <a href={PLUGINS_SCREEN} style={styles.link}>
            {t("view.actions.armed")}
          </a>
          <a href={CONNECTED_APPS_SCREEN} style={styles.link}>
            {t("view.actions.connectedApps")}
          </a>
        </div>
      </Panel>
    </div>
  );
}
