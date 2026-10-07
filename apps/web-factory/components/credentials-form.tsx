"use client";

import { useActionState } from "react";
import type { CredentialsState } from "@/app/(signed-in)/actions";

/**
 * Issues an agent's broker credentials and shows them once. The password lives only in
 * this form's state: reloading the page drops it, and Web Factory cannot show it again.
 */
export function CredentialsForm({
  action,
  submit,
  confirm,
}: {
  action: (state: CredentialsState) => Promise<CredentialsState>;
  submit: string;
  confirm?: string;
}) {
  const [state, formAction, busy] = useActionState(action, {});
  const issued = state.issued;
  return (
    <>
      <form
        action={formAction}
        className="inline"
        onSubmit={(event) => {
          if (confirm && !window.confirm(confirm)) event.preventDefault();
        }}
      >
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Issuing…" : submit}
        </button>
        {state.error ? (
          <span className="error" role="alert">
            {state.error}
          </span>
        ) : null}
        {state.notice ? <span className="notice">{state.notice}</span> : null}
      </form>
      {issued ? (
        <div className="secret" role="status">
          <p>
            <strong>Copy the password now.</strong> It is not stored and will not be shown again.
          </p>
          <dl className="kv">
            <dt>User name</dt>
            <dd className="mono">{issued.username}</dd>
            <dt>Client id</dt>
            <dd className="mono">{issued.clientId}</dd>
            <dt>Password</dt>
            <dd className="mono" data-testid="issued-password">
              {issued.password}
            </dd>
          </dl>
          <p className="muted">
            On the agent host, put the password alone in /etc/zfactory-agent/mqtt-password (mode 0600, owned by
            zfactory-agent) and set:
          </p>
          <pre className="mono">
            {[
              `ZFACTORY_AGENT_MQTT_URL=${issued.brokerUrl ?? "mqtts://<broker>:8883"}`,
              `ZFACTORY_AGENT_SITE_ID=${issued.siteKey}`,
              `ZFACTORY_AGENT_ID=${issued.agentKey}`,
              `ZFACTORY_AGENT_MQTT_CLIENT_ID=${issued.clientId}`,
              `ZFACTORY_AGENT_MQTT_USERNAME=${issued.username}`,
              "ZFACTORY_AGENT_MQTT_PASSWORD_FILE=/etc/zfactory-agent/mqtt-password",
            ].join("\n")}
          </pre>
        </div>
      ) : null}
    </>
  );
}
