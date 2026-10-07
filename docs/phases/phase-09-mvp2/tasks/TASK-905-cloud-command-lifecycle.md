# TASK-905 — Remote Command/Setpoint Lifecycle, Authorization & Audit

Status: **DONE**
Linear: [ZFA-48](https://linear.app/recruit-verse/issue/ZFA-48)

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Implement the safe Web Factory -> MQTT -> Thin Client -> PLC command path while preserving PLC program/interlock authority.

## Scope
- Command/setpoint UI only for mappings declared remotely writable.
- Server-side authorization, validation and audit before publish.
- Command envelope with commandId, target site/agent/plc/mapping, value/type, config version and requestedBy.
- MQTT publish from Web Factory server only.
- Thin Client independently re-validates its exported allow-list.
- Idempotency for duplicate MQTT delivery.
- Command lifecycle: REQUESTED -> PUBLISHED -> ACCEPTED/REJECTED -> APPLIED/FAILED, with timeout state.
- Correlate acknowledgement and subsequent PLC feedback.
- Never expose arbitrary Modbus address write from the cloud UI.
- Never use normal remote control to force local physical output image directly.

## Acceptance criteria
- Unauthorized/unmapped/out-of-range commands are rejected before publish or by the edge allow-list.
- Duplicate commandId cannot repeat actuation.
- Every command has an auditable user, target, value, timestamps and result.
- Feedback/acknowledgement is visible in Web Factory.
- PLC program/interlocks remain the final authority for physical outputs.

## As built
Design: ADR-0022, `docs/web-factory.md` → Commands and setpoints. The agent needed no change: it already checks, writes once, reads back and answers.
- **UI:** command controls appear only on writable COMMAND (on/off) and SETPOINT (number in range) tags of the PLC page, and only for operators and admins. A live commands table shows who sent what, the status with rule and reason, the read-back and the telemetry confirmation.
- **Before publishing** (`lib/services/command-service.ts`, `lib/domain/commands.ts`):
  - the `command` permission (a viewer is refused and audited);
  - the tag in the registered deployment: WRITE, COMMAND or SETPOINT, EXTERNAL_COMMAND;
  - the value's type and range;
  - the agent onboarded and reachable.

  Every refusal is stored as REJECTED with its rule, audited, and never published.
- **Envelope:** exactly the agent's `zfactory.command` v1, with commandId, plcId, mappingId, value, the registered configVersion, issuedAt, expiresAt (60 s) and requestedBy (a user id). It is published with QoS 1 to `zfactory/{site}/{agent}/command/{plc}`, only from the server.
- **Broker right:** Web Factory grants its own client the role `web-factory-commands` (publish to `zfactory/+/+/command/+` only), changing it only when it differs, since Mosquitto disconnects a client whose roles change. If the broker cannot take a command, it is FAILED and nothing reached a PLC.
- **Lifecycle:**
  - REQUESTED → PUBLISHED → ACCEPTED → APPLIED or FAILED, or REJECTED;
  - TIMED_OUT 10 s after expiry, swept with the alarms;
  - answers move forward only, and a late final answer is kept and marked late;
  - final answers are audited.
- **Idempotency:**
  - a request key per form, unique per user, so a double submit (even concurrent) is one command;
  - a redelivered command is answered by the agent as a duplicate, counted and never written;
  - answers are applied only for the topic's agent and PLC.
- **Feedback:** the agent's read-back (`observed`) on APPLIED, and the first telemetry after the write that shows the commanded value (*confirmed*).
- **API (read only):** `/api/v1/plcs/{id}/commands` and `/api/v1/commands/{id}`. Commands are sent only through the page's server action.
- **Data:** migration `commands`.

## Acceptance criteria — evidence
- **Unauthorized, unmapped and out-of-range commands are rejected before publishing, or by the edge:**
  - before publishing (database tests and browser): a viewer, an unknown tag, a status tag, a wrong type, an out-of-range value forced past the form's limits ("Speed_SP takes 0 to 50"), an offline or revoked agent; none was published;
  - at the edge, with the real agent: a forged command to a status tag is REJECTED `not-writable`, and a command for a newer registration is REJECTED `stale-config-version`.
- **A duplicate commandId cannot actuate twice:**
  - with the real agent, a redelivered setpoint is answered as a duplicate and the simulated PLC counts one write;
  - in the browser, a double submit made one command ("Already sent.");
  - the browser session's PLC saw exactly 3 writes for 3 accepted commands.
- **Every command is auditable:** the user, the target (PLC and tag), the value, the configuration version, requested, published, accepted and completed times, and the result with rule and reason. It is audited at request, refusal and final answer.
- **Feedback and acknowledgement are visible:** the status, read-back and telemetry confirmation are shown live on the PLC page and in the API.
- **The PLC program stays the authority:**
  - only command and setpoint tags of external command memory are written;
  - no address or output is accepted from the cloud;
  - the agent checks again;
  - in the browser session the simulated PLC program set Running from Start_Cmd, and Web Factory showed what it did.

## Evidence
- `npm test` in `apps/web-factory` passes: 15 files, 86 tests, with Docker and the real agent. The broker and end-to-end suites (14 tests) passed 3 times in a row, with every container removed.
- Root project: prettier, lint, typecheck and build are clean, and `TEST_DOCKER=1 npm test` (with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`) passes: 97 files, 1034 tests.
- The app's lint, typecheck, prettier and `next build` are clean.
- **Browser check:** headless Chromium, `next start` on 3211, against a temporary Mosquitto, a simulated Modbus PLC that counts writes, the real agent, and a temporary organization with an operator and a viewer in the dev database `web_factory`. The database was emptied again afterwards, including its day partitions.
  1. At start-up Web Factory granted itself the command role, with one reconnect.
  2. The operator saw the Command column only on Start_Cmd and Speed_SP. *On* was applied, read back *on*, and confirmed by telemetry.
  3. A 33.3 Hz setpoint was applied, read back 33.3, and confirmed; the PLC received 333 (tenths).
  4. 99, forced past the form's limits, was refused by the server and listed as rejected with the reason.
  5. A double submit of 12.5 made one command: the second answer was "Already sent."
  6. The viewer saw the four commands but no Command column.
  7. With the agent killed, a command was refused: "Edge gateway 1 is not connected; the command would only expire."
  8. The simulated PLC's log shows exactly three writes (coil 800 on, register 101 = 333, then 125). No password appears in any log, and the server logged no error.

