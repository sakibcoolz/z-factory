# TASK-404 — Live 3D Runtime-State Visualization

Status: **DONE**
Linear: [ZFA-23](https://linear.app/recruit-verse/issue/ZFA-23)

## Objective
Map canonical live runtime state and telemetry onto the reusable catalog 3D scene without changing the underlying GLB asset.

## State rules
- RUNNING: green outline/emphasis around the device.
- FAULTED: red outline/emphasis around the device.
- DEGRADED or stale: warning treatment consistent with Z-Factory design tokens.
- DISCONNECTED: disconnected/external treatment consistent with Z-Factory design tokens.
- STOPPED/STARTING/STOPPING: distinct non-fault states without misrepresenting them as running or faulted.

## Connection rules
- A connection whose endpoint is FAULTED is rendered red.
- A healthy active connection may be green and/or animated.
- Connection visuals derive from canonical relationship + runtime state; the 3D view does not invent connectivity.
- When status changes, device and related connection visuals update from the event/telemetry stream without regenerating the model.

## Acceptance criteria
- Consume TASK-401 live events/telemetry and the same canonical state used by topology/live tags.
- Apply runtime appearance as renderer overlays/material/outline effects rather than modifying the stored GLB.
- A device state transition is reflected in the 3D scene without page-level business-state duplication.
- FAULTED devices and their affected connections are visually obvious in red.
- RUNNING devices are visually obvious in green.
- Existing design-system fault/running/degraded/disconnected semantics remain consistent between 2D and 3D views.
- Motion/animation, when present, stops or changes appropriately on fault/disconnect.
- Missing telemetry degrades gracefully and never shows a false healthy state.

## Evidence (2026-10-05)
- **Consumes the live stream and the canonical state.** The scene subscribes to the factory's stream of TASK-401. Device states are the ones `getDeviceStates` works out on the server from simulator memory and the stored runtime state, the same source the stream's snapshot uses.
- **Overlays, not changes to the GLB.** State is a ring on the floor, a frame around the device's space and the colour of its connections and label. The loaded asset is shared by all instances and is not touched.
- **No business state in the page.** The server follows recorded events with a `devices` message; the client keeps what it was sent and maps it to an appearance. It never derives a state from an event.
- **Red and green.** In a browser on a production build with a real OpenPLC runtime and a running simulation, with the 3D page never reloaded: starting the PLC and the simulation turned PLC, valve, motor and pump green; injecting an overload on the motor turned it red with a pulsing ring and its connection to the pump red; clearing and resetting turned it green again; stopping returned everything to plain.
- **Same semantics in 2D and 3D.** Tones come from `runtimeStateTone`, now a domain rule the state pills use too, and connections from the 2D view's `edgeTone`. Tests compare both for every state and every pair of states.
- **Motion stops on fault and disconnect.** Only healthy connections flow. Tests cover a faulted end, an end that does not answer and an interrupted stream.
- **Never a false healthy state.** With the stream paused in the browser, every running device was shown amber as "Running · stale" and came back green on reconnect. A test checks for every state that nothing unconfirmed is shown green.
- Tests added: 14 (8 appearance rules, 5 scene view, 1 stream), with one stream-encoding assertion. 657 tests pass with database and Docker tests enabled; format check, lint, typecheck and build pass.

## Decisions made in this task
- **A `devices` message on the stream.** After recorded events the server sends the state of every device (once per burst). The alternative, mapping event types to states in the browser, would have been a second copy of the state rules.
- **Ring and frame instead of a silhouette outline.** A true outline needs a post-processing pass or a change to the model's materials. The frame is exact about which device it marks and costs nothing per model.
- **A fault outlives its confirmation.** When the stream is interrupted a device last known as faulted stays red, while one last known as running turns amber: wrongly showing a fault is safer than wrongly showing health.
- **"No answer"** is shown for a started PLC the tag monitor cannot reach, in the design system's disconnected colour.
- **The renderer runs continuously only while something moves** (a fault pulse or a flowing connection); otherwise it draws on change.

## Not in this task
- Motion of the devices themselves (rotors, valve travel) and motion scaled by tag values. Generic shapes are rotationally symmetric and an asset has no known moving part.
- Tag values in the scene (for example a speed next to a motor); the Live Tags screen has them.
- A PLC runtime's state is the last one stored (it changes with recorded events); the Runtime screen reads the container itself.
