# ADR-0022 — Cloud Commands and Setpoints

Status: **ACCEPTED** (TASK-905, 2026-10-07)

## Context
Operators must be able to send commands and setpoints from Web Factory to a PLC through its Thin Client Agent. The PLC program and its interlocks must stay the authority over physical outputs (ADR-0015). The agent already checks each command against the deployment it runs, answers on `ack/{plcId}` and remembers command ids, so a redelivered command is answered again but never written twice (ADR-0017). MQTT delivers at least once, so a command can arrive more than once.

## Decision
1. **What may be written:** only tags of the registered deployment that are WRITE, with role COMMAND or SETPOINT and authority EXTERNAL_COMMAND. A BOOL tag takes on or off; any other tag a finite number in its exported range.
   - The cloud UI offers controls only for those tags, and the server checks again before publishing.
   - No Modbus address, area or raw output is ever accepted from the cloud.
2. **Who:** operators and admins (the `command` permission). A viewer's attempt is refused and audited as `COMMAND_REFUSED`.
3. **Every attempt is recorded.** A command refused by Web Factory, for its tag, type, range, an unregistered or offline agent, or revoked credentials, is stored as REJECTED with its rule and reason, audited, and never published. An accepted one is audited as `COMMAND_REQUESTED`.
4. **The envelope** is the agent's `zfactory.command` version 1, exactly (the agent refuses unknown fields). It carries:
   - `commandId` (the Web Factory command's id), `plcId`, `mappingId` and `value`;
   - the registered `configVersion`;
   - `issuedAt`, and `expiresAt` 60 s later (the agent accepts at most 10 minutes);
   - `requestedBy`, the user's id: no e-mail goes to the edge.

   It is published with QoS 1, not retained, to `zfactory/{site}/{agent}/command/{plc}`.
5. **Web Factory may publish commands, and nothing else** (amending ADR-0019).
   - On connecting, it gives its own broker client the role `web-factory-commands`, allowing publication to `zfactory/+/+/command/+` only.
   - Mosquitto disconnects a client whose roles change. The role is therefore checked and changed only when it differs, and the first grant costs one reconnect.
   - If the broker cannot take a command, the command is FAILED (`broker-unavailable`) and nothing reached a PLC.
6. **Lifecycle:**
   - REQUESTED → PUBLISHED → ACCEPTED → APPLIED or FAILED;
   - REJECTED, by Web Factory or by the agent, with its rule;
   - TIMED_OUT, when there is no final answer 10 s after expiry.

   An answer never moves a command back. A final answer after a timeout is taken and marked late. Final answers are audited (`COMMAND_APPLIED`, `…_FAILED`, `…_REJECTED`).
7. **No double actuation:**
   - A form carries a request key, so the same form sent twice is one command; the database enforces `(requestedBy, requestKey)` as unique.
   - The agent writes a commandId once; its answer to a redelivery is marked duplicate and only counted.
   - An answer is applied only for a command of the agent and PLC whose topic it came on.
8. **Feedback:**
   - APPLIED carries the value the agent read back after writing.
   - Web Factory shows the first telemetry after the write that has the commanded value ("confirmed").
   - What the machine then does is the PLC program's: its feedback and status tags arrive with the polls.

## Consequences
- **Offline agents:** a command is refused when the agent is not reachable, rather than published to expire.
- **Version check:** the agent refuses a command for another configuration version than it runs. Registering a newer deployment in Web Factory before the agent runs it makes commands fail visibly with `stale-config-version`.
- **API:** commands are sent only through the signed-in page's server action. The JSON API reads them (`/api/v1/plcs/{id}/commands`, `/api/v1/commands/{id}`).
- **Deadline at the edge (amended by TASK-907, GitHub issue 50):** the agent carries `expiresAt` into its PLC worker's queue and checks it again immediately before the write, after any wait for the PLC connection. A command that expires while it waits is answered FAILED `command-expired` with nothing written. Web Factory shows it as failed, with the rule. This relies on time-synchronized clocks (NTP) on the edge host and the cloud.
