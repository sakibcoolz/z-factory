package device

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"
)

const tick = 0.1

// run steps the simulation for seconds of simulated time and collects every event.
func run(t *testing.T, s *Simulation, seconds float64) []Event {
	t.Helper()
	var events []Event
	for step := 0; step < int(math.Round(seconds/tick)); step++ {
		stepped, err := s.Step(tick)
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, stepped...)
	}
	return events
}

func params(t *testing.T, value any) json.RawMessage {
	t.Helper()
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func config(id, name, profile string, parameters any, links map[string]string) Config {
	raw, _ := json.Marshal(parameters)
	if parameters == nil {
		raw = nil
	}
	return Config{DeviceID: id, Name: name, Profile: profile, ProfileVersion: 1, Parameters: raw, Links: links}
}

// chain is a VFD → motor → pump, with a pressure transmitter on the pump.
func chain(suffix string, vfd, motor, pump, sensor any) []Config {
	if sensor == nil {
		sensor = map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "pressure"}}
	}
	return []Config{
		config("vfd"+suffix, "VFD"+suffix, "VFD", vfd, nil),
		config("motor"+suffix, "M"+suffix, "MOTOR", motor, map[string]string{"drive": "vfd" + suffix}),
		config("pump"+suffix, "P"+suffix, "PUMP", pump, map[string]string{"motor": "motor" + suffix}),
		config("pt"+suffix, "PT"+suffix, "SENSOR", sensor, map[string]string{"measures": "pump" + suffix}),
	}
}

func simulate(t *testing.T, configs ...Config) *Simulation {
	t.Helper()
	s, err := NewSimulation("factory", configs, Options{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func inputs(t *testing.T, s *Simulation, id string, values Values) {
	t.Helper()
	if err := s.SetInputs(id, values); err != nil {
		t.Fatal(err)
	}
}

func outputs(t *testing.T, s *Simulation, id string) Values {
	t.Helper()
	values, err := s.Outputs(id)
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func near(t *testing.T, got, want, tolerance float64, what string) {
	t.Helper()
	if math.Abs(got-want) > tolerance {
		t.Fatalf("%s: got %g, want %g", what, got, want)
	}
}

func expectRule(t *testing.T, err error, rule string) {
	t.Helper()
	var configErr *ConfigError
	var stateErr *StateError
	switch {
	case errors.As(err, &configErr):
		if configErr.Rule != rule {
			t.Fatalf("rule %s, want %s (%v)", configErr.Rule, rule, err)
		}
	case errors.As(err, &stateErr):
		if stateErr.Rule != rule {
			t.Fatalf("rule %s, want %s (%v)", stateErr.Rule, rule, err)
		}
	default:
		t.Fatalf("expected a refusal with rule %s, got %v", rule, err)
	}
}

func TestEveryProfileDescribesItself(t *testing.T) {
	want := []string{"COMPRESSOR", "CONVEYOR", "FAN", "HEATER", "INDICATOR", "MIXER", "MOTOR", "PUMP", "RELAY", "SENSOR", "SWITCH", "VALVE", "VFD"}
	var shipped []string
	for _, key := range Profiles() {
		if key != "BROKEN" {
			shipped = append(shipped, key)
		}
	}
	if !reflect.DeepEqual(shipped, want) {
		t.Fatalf("profiles %v", shipped)
	}
	for _, key := range shipped {
		description, err := Describe(key)
		if err != nil || description.Key != key || description.Version != 1 || len(description.Signals) == 0 || description.Summary == "" {
			t.Fatalf("%s: %+v %v", key, description, err)
		}
		seen := map[string]bool{}
		for _, signal := range description.Signals {
			if seen[signal.Key] {
				t.Fatalf("%s names %s twice", key, signal.Key)
			}
			seen[signal.Key] = true
		}
		behavior, _ := New(key)
		if err := behavior.Configure(nil); err != nil {
			t.Fatalf("%s with defaults: %v", key, err)
		}
	}
}

func TestVfdRampsAndReportsItsState(t *testing.T) {
	s := simulate(t, chain("1", map[string]any{"accelTimeS": 5, "decelTimeS": 10}, nil, nil, nil)...)
	if got := outputs(t, s, "vfd1"); got["running"] != 0 || got["actualFrequency"] != 0 || got["faulted"] != 0 {
		t.Fatalf("initial %v", got)
	}
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 40})
	events := run(t, s, 2)
	// 50 Hz in 5 s = 10 Hz/s.
	near(t, outputs(t, s, "vfd1")["actualFrequency"], 20, 1e-6, "frequency after 2 s")
	if got := outputs(t, s, "vfd1"); got["running"] != 1 || got["atSetpoint"] != 0 {
		t.Fatalf("accelerating %v", got)
	}
	if events[0].Type != "VFD_STATE_CHANGED" || events[0].Payload["from"] != "STOPPED" || events[0].Payload["to"] != "ACCELERATING" {
		t.Fatalf("first event %+v", events[0])
	}
	run(t, s, 2.5)
	if got := outputs(t, s, "vfd1"); got["actualFrequency"] != 40 || got["atSetpoint"] != 1 {
		t.Fatalf("at setpoint %v", got)
	}
	// Stop: 50 Hz in 10 s = 5 Hz/s down.
	inputs(t, s, "vfd1", Values{"run": 0, "frequencySetpoint": 40})
	run(t, s, 2)
	near(t, outputs(t, s, "vfd1")["actualFrequency"], 30, 1e-6, "decelerating")
	if outputs(t, s, "vfd1")["running"] != 1 {
		t.Fatal("still turning counts as running")
	}
	run(t, s, 6.5)
	if got := outputs(t, s, "vfd1"); got["actualFrequency"] != 0 || got["running"] != 0 {
		t.Fatalf("stopped %v", got)
	}

	// The setpoint is limited to the maximum frequency, and ignored without a run command.
	inputs(t, s, "vfd1", Values{"run": 0, "frequencySetpoint": 45})
	run(t, s, 3)
	if outputs(t, s, "vfd1")["actualFrequency"] != 0 {
		t.Fatal("a setpoint without run moved the drive")
	}
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 400})
	run(t, s, 10)
	if outputs(t, s, "vfd1")["actualFrequency"] != 50 {
		t.Fatalf("limit %v", outputs(t, s, "vfd1"))
	}
}

func TestVfdRampsThroughZeroOnReversal(t *testing.T) {
	s := simulate(t, chain("1", map[string]any{"accelTimeS": 5, "decelTimeS": 5}, nil, nil, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 20})
	run(t, s, 3)
	inputs(t, s, "vfd1", Values{"run": 1, "reverse": 1, "frequencySetpoint": 20})
	run(t, s, 1)
	near(t, outputs(t, s, "vfd1")["actualFrequency"], 10, 1e-6, "ramping down first")
	run(t, s, 4)
	if got := outputs(t, s, "vfd1"); got["actualFrequency"] != 20 || got["atSetpoint"] != 1 {
		t.Fatalf("reversed %v", got)
	}
}

func TestVfdTripsLatchesAndResetsOnARisingEdge(t *testing.T) {
	s := simulate(t, chain("1", nil, nil, nil, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 8)
	if outputs(t, s, "motor1")["running"] != 1 {
		t.Fatal("motor should run")
	}
	event, err := s.InjectFault("vfd1", "OVERCURRENT")
	if err != nil || event.Type != "FAULT_INJECTED" || event.Severity != Critical || event.Payload["latching"] != true {
		t.Fatalf("inject %+v %v", event, err)
	}
	events, _ := s.Step(tick)
	found := false
	for _, event := range events {
		if event.Type == "VFD_STATE_CHANGED" && event.Severity == Critical && event.DeviceID == "vfd1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no critical state event: %+v", events)
	}
	if got := outputs(t, s, "vfd1"); got["faulted"] != 1 || got["running"] != 0 || got["actualFrequency"] != 0 {
		t.Fatalf("tripped drive %v", got)
	}
	// The motor lost its supply and coasts down instead of stopping at once.
	if got := outputs(t, s, "motor1"); got["running"] != 0 || got["current"] != 0 || got["actualSpeed"] <= 1000 {
		t.Fatalf("coasting motor %v", got)
	}
	// A reset while the cause is present does nothing.
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50, "faultReset": 1})
	run(t, s, 1)
	if outputs(t, s, "vfd1")["faulted"] != 1 {
		t.Fatal("reset with the cause present")
	}
	_, err = s.Reset("vfd1")
	expectRule(t, err, "fault-active")
	// Clearing the cause leaves the drive tripped; a held reset signal is not a new edge.
	cleared, _ := s.ClearFault("vfd1", "OVERCURRENT")
	if cleared.Payload["stillTripped"] != true {
		t.Fatalf("clear %+v", cleared)
	}
	run(t, s, 1)
	if outputs(t, s, "vfd1")["faulted"] != 1 {
		t.Fatal("a held reset released the trip")
	}
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50, "faultReset": 0})
	s.Step(tick)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50, "faultReset": 1})
	run(t, s, 6)
	if got := outputs(t, s, "vfd1"); got["faulted"] != 0 || got["actualFrequency"] != 50 {
		t.Fatalf("after reset %v", got)
	}

	// The operator's reset once the cause is gone; unknown and repeated faults are refused.
	s.InjectFault("vfd1", "OVERTEMPERATURE")
	s.Step(tick)
	s.ClearFault("vfd1", "OVERTEMPERATURE")
	reset, err := s.Reset("vfd1")
	if err != nil || reset.Type != "DEVICE_RESET" || reset.Payload["wasTripped"] != true {
		t.Fatalf("reset %+v %v", reset, err)
	}
	_, err = s.InjectFault("vfd1", "DRY_RUN")
	expectRule(t, err, "supported-fault")
	s.InjectFault("vfd1", "OVERCURRENT")
	_, err = s.InjectFault("vfd1", "OVERCURRENT")
	expectRule(t, err, "fault-active")
	_, err = s.ClearFault("vfd1", "OVERTEMPERATURE")
	expectRule(t, err, "fault-not-active")
}

func TestLinksKeepTheInvariants(t *testing.T) {
	_, err := NewSimulation("f", []Config{
		config("vfd", "VFD-01", "VFD", nil, nil),
		config("m1", "M-01", "MOTOR", nil, map[string]string{"drive": "vfd"}),
		config("m2", "M-02", "MOTOR", nil, map[string]string{"drive": "vfd"}),
	}, Options{})
	expectRule(t, err, "one-motor-per-drive")
	_, err = NewSimulation("f", []Config{
		config("m1", "M-01", "MOTOR", nil, nil),
		config("m2", "M-02", "MOTOR", nil, map[string]string{"drive": "m1"}),
	}, Options{})
	expectRule(t, err, "drive")
	_, err = NewSimulation("f", []Config{
		config("vfd", "VFD-01", "VFD", nil, nil),
		config("p", "P-01", "PUMP", nil, map[string]string{"motor": "vfd"}),
	}, Options{})
	expectRule(t, err, "motor")
	_, err = NewSimulation("f", []Config{
		config("m", "M-01", "MOTOR", nil, nil),
		config("p1", "P-01", "PUMP", nil, map[string]string{"motor": "m"}),
		config("p2", "P-02", "PUMP", nil, map[string]string{"motor": "m"}),
	}, Options{})
	expectRule(t, err, "one-load-per-motor")
	_, err = NewSimulation("f", []Config{config("v", "XV", "VALVE", nil, map[string]string{"motor": "v"})}, Options{})
	expectRule(t, err, "link-role")
	_, err = NewSimulation("f", []Config{config("m", "M", "MOTOR", nil, map[string]string{"drive": "nowhere"})}, Options{})
	expectRule(t, err, "link-target")
	_, err = NewSimulation("f", append(chain("1", nil, nil, nil, nil), config("vfd1", "again", "VFD", nil, nil)), Options{})
	expectRule(t, err, "unique-device")
	_, err = NewSimulation("f", []Config{{DeviceID: "x", Name: "X", Profile: "BOILER", ProfileVersion: 1}}, Options{})
	expectRule(t, err, "profile")
	_, err = NewSimulation("f", []Config{{DeviceID: "x", Name: "X", Profile: "VFD", ProfileVersion: 2}}, Options{})
	expectRule(t, err, "profile-version")
}

func TestMotorFollowsItsDriveAndItsLoad(t *testing.T) {
	s := simulate(t, chain("1", nil, nil, nil, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 25})
	run(t, s, 10)
	half := outputs(t, s, "motor1")
	near(t, half["actualSpeed"], 725, 0.5, "half speed")
	// 35 % no-load current plus 65 % × (0.5)² of rated 10 A.
	near(t, half["current"], 3.5+6.5*0.25, 0.05, "half-speed current")
	if outputs(t, s, "vfd1")["outputCurrent"] != half["current"] {
		t.Fatal("the drive reports the motor's current")
	}
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 10)
	full := outputs(t, s, "motor1")
	if full["actualSpeed"] != 1450 || full["running"] != 1 {
		t.Fatalf("full speed %v", full)
	}
	near(t, full["current"], 10, 1e-6, "rated current")
}

func TestMotorStartsDirectOnLineWithoutADrive(t *testing.T) {
	s := simulate(t, config("m", "M-01", "MOTOR", map[string]any{"timeConstantS": 1}, nil))
	inputs(t, s, "m", Values{"run": 1})
	events := run(t, s, 1)
	// One time constant: 63 % of rated speed.
	near(t, outputs(t, s, "m")["actualSpeed"], 1450*(1-math.Exp(-1)), 0.5, "one time constant")
	events = append(events, run(t, s, 10)...)
	if got := outputs(t, s, "m"); got["actualSpeed"] != 1450 || got["running"] != 1 {
		t.Fatalf("rated %v", got)
	}
	near(t, outputs(t, s, "m")["current"], 3.5, 1e-6, "no-load current")
	inputs(t, s, "m", Values{"run": 0})
	events = append(events, run(t, s, 30)...)
	if got := outputs(t, s, "m"); got["actualSpeed"] != 0 || got["running"] != 0 || got["current"] != 0 {
		t.Fatalf("stopped %v", got)
	}
	var states []string
	for _, event := range events {
		if event.Type != "MOTOR_STATE_CHANGED" {
			t.Fatalf("event %+v", event)
		}
		states = append(states, event.Payload["to"].(string))
	}
	if !reflect.DeepEqual(states, []string{"RUNNING", "COASTING", "STOPPED"}) {
		t.Fatalf("states %v", states)
	}
}

func TestMotorTripsOnOverloadWhileTheDriveRuns(t *testing.T) {
	s := simulate(t, chain("1", nil, nil, nil, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 8)
	s.InjectFault("motor1", "OVERLOAD")
	run(t, s, 20)
	if got := outputs(t, s, "motor1"); got["faulted"] != 1 || got["running"] != 0 || got["actualSpeed"] != 0 {
		t.Fatalf("tripped motor %v", got)
	}
	if outputs(t, s, "vfd1")["actualFrequency"] != 50 {
		t.Fatal("the drive keeps running")
	}
	if got := outputs(t, s, "pump1"); got["running"] != 0 || got["flow"] != 0 {
		t.Fatalf("pump %v", got)
	}
	s.ClearFault("motor1", "OVERLOAD")
	s.Reset("motor1")
	run(t, s, 5)
	if got := outputs(t, s, "motor1"); got["faulted"] != 0 || got["actualSpeed"] != 1450 {
		t.Fatalf("after reset %v", got)
	}
}

func TestPumpAffinityLawsAndDryRunning(t *testing.T) {
	s := simulate(t, chain("1", nil, nil, map[string]any{"ratedFlow": 120, "ratedPressure": 6}, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 25})
	events := run(t, s, 10)
	near(t, outputs(t, s, "pump1")["flow"], 60, 0.1, "flow at half speed")
	near(t, outputs(t, s, "pump1")["pressure"], 1.5, 0.01, "pressure at half speed")
	near(t, outputs(t, s, "pt1")["value"], 1.5, 0.01, "transmitter")
	found := false
	for _, event := range events {
		if event.Type == "PUMP_STATE_CHANGED" && event.Payload["to"] == "RUNNING" {
			found = true
		}
	}
	if !found {
		t.Fatal("no pump running event")
	}

	s = simulate(t, chain("1", nil, nil, nil, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 8)
	event, _ := s.InjectFault("pump1", "DRY_RUN")
	if event.Severity != Warning {
		t.Fatalf("dry run severity %v", event.Severity)
	}
	s.Step(tick)
	if got := outputs(t, s, "pump1"); got["flow"] != 0 || got["pressure"] != 0 || got["running"] != 1 || got["faulted"] != 1 {
		t.Fatalf("dry %v", got)
	}
	near(t, outputs(t, s, "motor1")["current"], 3.5+6.5*0.2, 1e-6, "unloaded motor")
	// Not latching: clearing the cause restores the pump without a reset.
	s.ClearFault("pump1", "DRY_RUN")
	s.Step(tick)
	if got := outputs(t, s, "pump1"); got["flow"] != 100 || got["pressure"] != 4 || got["faulted"] != 0 {
		t.Fatalf("restored %v", got)
	}

	// Without a motor a pump stays still.
	s = simulate(t, config("p", "P-01", "PUMP", nil, nil))
	run(t, s, 5)
	if got := outputs(t, s, "p"); got["running"] != 0 || got["flow"] != 0 || got["pressure"] != 0 {
		t.Fatalf("still %v", got)
	}
}

func TestConveyorIsConstantTorqueAndFanQuadratic(t *testing.T) {
	s := simulate(t,
		config("m1", "M-01", "MOTOR", nil, nil),
		config("belt", "CV-01", "CONVEYOR", map[string]any{"ratedOutput": 2}, map[string]string{"motor": "m1"}),
		config("m2", "M-02", "MOTOR", nil, nil),
		config("fan", "FN-01", "FAN", nil, map[string]string{"motor": "m2"}),
	)
	inputs(t, s, "m1", Values{"run": 1})
	inputs(t, s, "m2", Values{"run": 1})
	events := run(t, s, 10)
	if got := outputs(t, s, "belt"); got["running"] != 1 || got["output"] != 2 {
		t.Fatalf("belt %v", got)
	}
	if got := outputs(t, s, "fan"); got["running"] != 1 || got["output"] != 100 {
		t.Fatalf("fan %v", got)
	}
	near(t, outputs(t, s, "m1")["current"], 10, 1e-6, "constant torque at full speed")
	found := false
	for _, event := range events {
		if event.Type == "DEVICE_STATE_CHANGED" && event.DeviceID == "belt" {
			found = true
		}
	}
	if !found {
		t.Fatal("no belt state event")
	}
}

func TestIndependentChainsAndDeterminism(t *testing.T) {
	configs := append(append(chain("1", nil, nil, nil, nil), chain("2", nil, nil, nil, nil)...), chain("3", map[string]any{"accelTimeS": 1}, nil, nil, nil)...)
	s := simulate(t, configs...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	inputs(t, s, "vfd3", Values{"run": 1, "frequencySetpoint": 10})
	run(t, s, 2)
	near(t, outputs(t, s, "vfd1")["actualFrequency"], 20, 1e-6, "chain 1")
	if outputs(t, s, "vfd2")["actualFrequency"] != 0 || outputs(t, s, "vfd3")["actualFrequency"] != 10 {
		t.Fatal("chains influenced each other")
	}
	s.InjectFault("vfd1", "OVERCURRENT")
	run(t, s, 10)
	if outputs(t, s, "pump1")["running"] != 0 || outputs(t, s, "pump2")["running"] != 0 {
		t.Fatal("pumps 1 and 2 should be still")
	}
	if got := outputs(t, s, "pump3"); got["running"] != 1 || got["faulted"] != 0 {
		t.Fatalf("pump 3 %v", got)
	}
	near(t, outputs(t, s, "pt3")["value"], 4*0.2*0.2, 1e-3, "pt3")
	if len(s.Snapshot()) != 12 {
		t.Fatal("twelve devices")
	}

	build := func() []Snapshot {
		s := simulate(t, append(chain("1", nil, nil, nil, nil), config("noise", "TT-01", "SENSOR", map[string]any{"source": map[string]any{"kind": "RANDOM", "min": 10, "max": 20, "seed": 7}}, nil))...)
		inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 37.5})
		run(t, s, 7.3)
		return s.Snapshot()
	}
	if !reflect.DeepEqual(build(), build()) {
		t.Fatal("not deterministic")
	}
}

func TestValveTravelsAndReportsLimitSwitches(t *testing.T) {
	s := simulate(t, config("v", "XV-01", "VALVE", map[string]any{"travelTimeS": 4}, nil))
	if got := outputs(t, s, "v"); got["position"] != 0 || got["closed"] != 1 || got["opened"] != 0 {
		t.Fatalf("initial %v", got)
	}
	inputs(t, s, "v", Values{"open": 1})
	events := run(t, s, 2)
	near(t, outputs(t, s, "v")["position"], 50, 1e-6, "half open")
	events = append(events, run(t, s, 2.5)...)
	if got := outputs(t, s, "v"); got["position"] != 100 || got["opened"] != 1 {
		t.Fatalf("open %v", got)
	}
	// Single-acting: without the open command it returns to closed.
	inputs(t, s, "v", Values{"open": 0})
	events = append(events, run(t, s, 5)...)
	if got := outputs(t, s, "v"); got["position"] != 0 || got["closed"] != 1 {
		t.Fatalf("closed %v", got)
	}
	var states []string
	for _, event := range events {
		if event.Type != "VALVE_STATE_CHANGED" {
			t.Fatalf("event %+v", event)
		}
		states = append(states, event.Payload["to"].(string))
	}
	if !reflect.DeepEqual(states, []string{"OPENING", "OPEN", "CLOSING", "CLOSED"}) {
		t.Fatalf("states %v", states)
	}

	// Double-acting: holds its position when neither command is present.
	s = simulate(t, config("v", "XV-01", "VALVE", map[string]any{"travelTimeS": 10}, nil))
	inputs(t, s, "v", Values{"open": 1, "close": 0})
	run(t, s, 3)
	inputs(t, s, "v", Values{"open": 0, "close": 0})
	run(t, s, 3)
	near(t, outputs(t, s, "v")["position"], 30, 1e-6, "held")
	inputs(t, s, "v", Values{"open": 0, "close": 1})
	run(t, s, 4)
	if got := outputs(t, s, "v"); got["position"] != 0 || got["closed"] != 1 {
		t.Fatalf("closed again %v", got)
	}

	// An analog position setpoint, limited to the stroke.
	s = simulate(t, config("v", "XV-01", "VALVE", map[string]any{"travelTimeS": 10, "initialPosition": 100}, nil))
	inputs(t, s, "v", Values{"positionSetpoint": 35})
	run(t, s, 20)
	if got := outputs(t, s, "v"); got["position"] != 35 || got["opened"] != 0 || got["closed"] != 0 {
		t.Fatalf("setpoint %v", got)
	}
	inputs(t, s, "v", Values{"positionSetpoint": 250})
	run(t, s, 20)
	if outputs(t, s, "v")["position"] != 100 {
		t.Fatal("setpoint beyond the stroke")
	}

	// Stuck: no movement, and the valve does not report it itself.
	s = simulate(t, config("v", "XV-01", "VALVE", map[string]any{"travelTimeS": 4}, nil))
	s.InjectFault("v", "STUCK")
	inputs(t, s, "v", Values{"open": 1})
	run(t, s, 10)
	if got := outputs(t, s, "v"); got["position"] != 0 || got["closed"] != 1 || got["faulted"] != 0 {
		t.Fatalf("stuck %v", got)
	}
	if snapshot := s.Snapshot()[0]; !snapshot.Faulted || !reflect.DeepEqual(snapshot.ActiveFaults, []string{"STUCK"}) {
		t.Fatalf("snapshot %+v", snapshot)
	}
	s.ClearFault("v", "STUCK")
	run(t, s, 5)
	if outputs(t, s, "v")["opened"] != 1 {
		t.Fatal("not open after the fault cleared")
	}
}

func sensorWith(parameters any, measured ...Config) []Config {
	links := map[string]string{}
	if len(measured) > 0 {
		links["measures"] = measured[0].DeviceID
	}
	return append(measured, config("s", "TT-01", "SENSOR", parameters, links))
}

func TestSensorSourcesLagRangeAndEvents(t *testing.T) {
	s := simulate(t, sensorWith(map[string]any{"source": map[string]any{"kind": "CONSTANT", "value": 21.5}})...)
	run(t, s, 3)
	if outputs(t, s, "s")["value"] != 21.5 {
		t.Fatal("constant")
	}
	s = simulate(t, sensorWith(map[string]any{"source": map[string]any{"kind": "RAMP", "from": 0, "to": 100, "periodS": 10}})...)
	run(t, s, 2.5)
	near(t, outputs(t, s, "s")["value"], 25, 1e-6, "ramp")
	run(t, s, 10)
	near(t, outputs(t, s, "s")["value"], 25, 1e-6, "ramp repeats")
	s = simulate(t, sensorWith(map[string]any{"source": map[string]any{"kind": "SINE", "min": 10, "max": 30, "periodS": 8}})...)
	run(t, s, 2)
	near(t, outputs(t, s, "s")["value"], 30, 1e-6, "sine peak")
	run(t, s, 4)
	near(t, outputs(t, s, "s")["value"], 10, 1e-6, "sine trough")

	// Random samples are reproducible and inside the limits.
	random := map[string]any{"source": map[string]any{"kind": "RANDOM", "min": 5, "max": 6, "intervalS": 0.5, "seed": 42}}
	first, second := simulate(t, sensorWith(random)...), simulate(t, sensorWith(random)...)
	values := map[float64]bool{}
	for step := 0; step < 100; step++ {
		first.Step(tick)
		second.Step(tick)
		value := outputs(t, first, "s")["value"]
		if value != outputs(t, second, "s")["value"] || value < 5 || value >= 6 {
			t.Fatalf("random %g", value)
		}
		values[value] = true
	}
	if len(values) <= 10 {
		t.Fatal("random samples do not vary")
	}

	// A measured signal with gain, offset, lag and range limits.
	s = simulate(t, sensorWith(
		map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "position", "gain": 0.16, "offset": 4}, "timeConstantS": 1, "rangeMin": 4, "rangeMax": 12},
		config("v", "XV-01", "VALVE", map[string]any{"initialPosition": 100, "travelTimeS": 1}, nil),
	)...)
	inputs(t, s, "v", Values{"positionSetpoint": 100})
	run(t, s, 0.3)
	if value := outputs(t, s, "s")["value"]; value <= 4 || value >= 12 {
		t.Fatalf("lagging %g", value)
	}
	run(t, s, 20)
	if outputs(t, s, "s")["value"] != 12 {
		t.Fatal("range limit")
	}

	// A value event only when the value moves by the deadband: 1 unit per second, crossings near 5, 10, 15, 20.
	s = simulate(t, sensorWith(map[string]any{"source": map[string]any{"kind": "RAMP", "from": 0, "to": 100, "periodS": 100}, "eventDeadband": 5})...)
	events := run(t, s, 22)
	if len(events) != 4 {
		t.Fatalf("%d events", len(events))
	}
	for _, event := range events {
		if event.Type != "SENSOR_VALUE_CHANGED" {
			t.Fatalf("event %+v", event)
		}
	}
}

func TestSensorSignalLossStuckAndForcing(t *testing.T) {
	s := simulate(t, sensorWith(map[string]any{"source": map[string]any{"kind": "RAMP", "from": 4, "to": 20, "periodS": 16}, "rangeMin": 4, "rangeMax": 20})...)
	run(t, s, 4)
	near(t, outputs(t, s, "s")["value"], 8, 1e-6, "before loss")
	s.InjectFault("s", "BAD_QUALITY")
	events, _ := s.Step(tick)
	if got := outputs(t, s, "s"); got["value"] != 4 || got["faulted"] != 1 {
		t.Fatalf("lost %v", got)
	}
	if snapshot := s.Snapshot()[0]; snapshot.Quality != "BAD" || snapshot.State != "BAD" {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if len(events) != 1 || events[0].Type != "SENSOR_VALUE_CHANGED" {
		t.Fatalf("events %+v", events)
	}
	s.ClearFault("s", "BAD_QUALITY")
	s.Step(tick)
	if outputs(t, s, "s")["faulted"] != 0 {
		t.Fatal("still faulted")
	}
	near(t, outputs(t, s, "s")["value"], 8.2, 1e-6, "after loss")
	s.InjectFault("s", "STUCK")
	run(t, s, 3)
	near(t, outputs(t, s, "s")["value"], 8.2, 1e-6, "stuck")
	if outputs(t, s, "s")["faulted"] != 0 {
		t.Fatal("a stuck sensor does not report it")
	}

	s = simulate(t, sensorWith(map[string]any{"source": map[string]any{"kind": "CONSTANT", "value": 2}})...)
	nine := 9.5
	event, err := s.Force("s", &nine)
	if err != nil || event.Type != "SIMULATED_INPUT_FORCED" {
		t.Fatalf("force %+v %v", event, err)
	}
	s.Step(tick)
	if outputs(t, s, "s")["value"] != 9.5 {
		t.Fatal("forced value")
	}
	if len(s.Forced()) != 1 {
		t.Fatal("forced list")
	}
	event, _ = s.Force("s", nil)
	if event.Type != "SIMULATED_INPUT_RELEASED" {
		t.Fatalf("release %+v", event)
	}
	s.Step(tick)
	if outputs(t, s, "s")["value"] != 2 {
		t.Fatal("released value")
	}
	s = simulate(t, config("v", "XV-01", "VALVE", nil, nil))
	_, err = s.Force("v", &nine)
	expectRule(t, err, "forcible-device")

	// A measured source without a device, an unknown signal, and invalid parameters are refused.
	_, err = NewSimulation("f", sensorWith(map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "pressure"}}), Options{})
	expectRule(t, err, "measured-device")
	_, err = NewSimulation("f", sensorWith(map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "pressure"}}, config("v", "XV-01", "VALVE", nil, nil)), Options{})
	expectRule(t, err, "measured-signal")
	_, err = NewSimulation("f", sensorWith(map[string]any{"source": map[string]any{"kind": "CONSTANT", "value": 1}, "rangeMin": 10, "rangeMax": 5}), Options{})
	expectRule(t, err, "simulation-params")
	_, err = NewSimulation("f", sensorWith(map[string]any{"unknownOption": true}), Options{})
	expectRule(t, err, "simulation-params")
}

func TestSwitchConstantForcedMeasuredAndStuck(t *testing.T) {
	s := simulate(t, config("sw", "HS-01", "SWITCH", nil, nil))
	if outputs(t, s, "sw")["state"] != 0 {
		t.Fatal("initial")
	}
	on := 1.0
	s.Force("sw", &on)
	events, _ := s.Step(tick)
	if outputs(t, s, "sw")["state"] != 1 {
		t.Fatal("forced on")
	}
	if len(events) != 1 || events[0].Type != "DEVICE_STATE_CHANGED" || events[0].Payload["from"] != "OFF" || events[0].Payload["to"] != "ON" {
		t.Fatalf("events %+v", events)
	}
	three := 3.0
	_, err := s.Force("sw", &three)
	expectRule(t, err, "forcible-device")

	s = simulate(t, append(chain("1", nil, nil, nil, nil), config("ps", "PS-01", "SWITCH", map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "pressure", "onAbove": 3, "offBelow": 1}}, map[string]string{"measures": "pump1"}))...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 8)
	if outputs(t, s, "ps")["state"] != 1 {
		t.Fatal("on above 3")
	}
	// 30 Hz → 1.44 bar: between the two thresholds, so the switch keeps its state.
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 30})
	run(t, s, 8)
	if outputs(t, s, "ps")["state"] != 1 {
		t.Fatal("hysteresis")
	}
	inputs(t, s, "vfd1", Values{"run": 0})
	run(t, s, 15)
	if outputs(t, s, "ps")["state"] != 0 {
		t.Fatal("off below 1")
	}

	s = simulate(t, config("sw", "LS-01", "SWITCH", nil, nil))
	s.InjectFault("sw", "STUCK")
	s.Force("sw", &on)
	run(t, s, 1)
	if outputs(t, s, "sw")["state"] != 0 {
		t.Fatal("stuck switch moved")
	}
}

func TestCatalogFaultOverridesAndInputValidation(t *testing.T) {
	critical, latching := Critical, true
	s := simulate(t, Config{DeviceID: "v", Name: "XV-01", Profile: "VALVE", ProfileVersion: 1, Faults: map[string]FaultOverride{"STUCK": {Severity: &critical, Latching: &latching}}})
	event, _ := s.InjectFault("v", "STUCK")
	if event.Severity != Critical || event.Payload["latching"] != true {
		t.Fatalf("override %+v", event)
	}
	s.Step(tick)
	s.ClearFault("v", "STUCK")
	inputs(t, s, "v", Values{"open": 1})
	run(t, s, 10)
	// Tripped: still frozen after the cause is gone.
	if got := outputs(t, s, "v"); got["position"] != 0 || got["faulted"] != 1 {
		t.Fatalf("tripped valve %v", got)
	}
	s.Reset("v")
	run(t, s, 10)
	if outputs(t, s, "v")["opened"] != 1 {
		t.Fatal("not open after reset")
	}
	_, err := NewSimulation("f", []Config{{DeviceID: "v", Name: "XV", Profile: "VALVE", ProfileVersion: 1, Faults: map[string]FaultOverride{"DRY_RUN": {}}}}, Options{})
	expectRule(t, err, "supported-fault")

	s = simulate(t, chain("1", nil, nil, nil, nil)...)
	if err := s.SetInputs("missing", Values{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing device: %v", err)
	}
	expectRule(t, s.SetInputs("vfd1", Values{"flow": 1}), "input-signal")
	if _, err := s.Step(-1); err == nil {
		t.Fatal("negative step")
	}
}

func TestUpsertAndRemoveKeepTheOthersRunning(t *testing.T) {
	s := simulate(t, chain("1", nil, nil, nil, nil)...)
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 8)
	// A valve joins; the chain keeps its state.
	if err := s.Upsert(config("v", "XV-01", "VALVE", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if s.Count() != 5 || outputs(t, s, "motor1")["actualSpeed"] != 1450 {
		t.Fatal("the chain lost its state")
	}
	// The pump is replaced with other parameters: fresh state, same motor.
	if err := s.Upsert(config("pump1", "P1", "PUMP", map[string]any{"ratedFlow": 10}, map[string]string{"motor": "motor1"})); err != nil {
		t.Fatal(err)
	}
	s.Step(tick)
	if outputs(t, s, "pump1")["flow"] != 10 {
		t.Fatalf("replaced pump %v", outputs(t, s, "pump1"))
	}
	// A replacement that breaks an invariant leaves everything as it was.
	expectRule(t, s.Upsert(config("motor2", "M2", "MOTOR", nil, map[string]string{"drive": "vfd1"})), "one-motor-per-drive")
	if s.Count() != 5 {
		t.Fatal("a refused device was kept")
	}
	// A linked device cannot go before its dependants.
	expectRule(t, s.Remove("motor1"), "linked-device")
	if err := s.Remove("pt1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("pump1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("motor1"); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(s.Remove("motor1"), ErrNotFound) {
		t.Fatal("removed twice")
	}
	run(t, s, 1)
	if outputs(t, s, "vfd1")["actualFrequency"] != 50 || outputs(t, s, "vfd1")["outputCurrent"] != 0 {
		t.Fatalf("drive without a motor %v", outputs(t, s, "vfd1"))
	}
}

// broken is a profile that fails or dawdles, registered for the isolation tests only.
type broken struct {
	panics bool
	sleep  time.Duration
	steps  int
}

func (b *broken) Profile() string                     { return "BROKEN" }
func (b *broken) Version() int                        { return 1 }
func (b *broken) Configure(raw json.RawMessage) error { return nil }
func (b *broken) Step(_ float64, _ *Context) {
	b.steps++
	if b.panics {
		panic("division by zero in the model")
	}
	time.Sleep(b.sleep)
}
func (b *broken) Outputs(_ *Context) Values    { return Values{"steps": float64(b.steps)} }
func (b *broken) State() string                { return "RUNNING" }
func (b *broken) Internal() map[string]float64 { return nil }

func init() {
	Register("BROKEN", func() Behavior { return &broken{} }, func() Description {
		return Description{Key: "BROKEN", Version: 1, Summary: "test only", Signals: []Signal{{Key: "steps", Direction: Out, Kind: Number}}}
	})
}

func TestABadOrSlowBehaviourDoesNotStallTheOthers(t *testing.T) {
	configs := append(chain("1", nil, nil, nil, nil), config("bad", "BAD", "BROKEN", nil, nil), config("slow", "SLOW", "BROKEN", nil, nil))
	s, err := NewSimulation("f", configs, Options{StepBudget: time.Millisecond, MaxOverruns: 2})
	if err != nil {
		t.Fatal(err)
	}
	bad, _ := s.Device("bad")
	bad.behavior.(*broken).panics = true
	slow, _ := s.Device("slow")
	slow.behavior.(*broken).sleep = 3 * time.Millisecond
	inputs(t, s, "vfd1", Values{"run": 1, "frequencySetpoint": 50})

	events := run(t, s, 1)
	var types []string
	for _, event := range events {
		if event.DeviceID == "bad" || event.DeviceID == "slow" {
			types = append(types, event.Type)
		}
	}
	if !reflect.DeepEqual(types, []string{"DEVICE_RUNTIME_FAULT", "DEVICE_QUARANTINED"}) {
		t.Fatalf("isolation events %v", types)
	}
	if bad.Snapshot().Status != StatusFaulted || bad.Snapshot().Quality != "BAD" || bad.Snapshot().Error == "" {
		t.Fatalf("bad %+v", bad.Snapshot())
	}
	// Two overruns after the settling step at construction, then no more steps.
	if slow.Snapshot().Status != StatusQuarantined || slow.behavior.(*broken).steps != 3 {
		t.Fatalf("slow %+v", slow.Snapshot())
	}
	// The chain went on as if the two were not there.
	near(t, outputs(t, s, "vfd1")["actualFrequency"], 10, 1e-6, "healthy drive")
	if counts := s.Status(); counts[StatusOK] != 4 || counts[StatusFaulted] != 1 || counts[StatusQuarantined] != 1 {
		t.Fatalf("status %v", counts)
	}
	// Configuring the device again brings it back.
	if err := s.Upsert(config("bad", "BAD", "BROKEN", nil, nil)); err != nil {
		t.Fatal(err)
	}
	s.Step(tick)
	if fixed, _ := s.Device("bad"); fixed.Snapshot().Status != StatusOK || outputs(t, s, "bad")["steps"] != 1 {
		t.Fatalf("fixed %+v", fixed.Snapshot())
	}
}

func TestInputsAreCheckedAgainstTheProfile(t *testing.T) {
	_, err := NewSimulation("f", []Config{{DeviceID: "v", Name: "XV", Profile: "VALVE", ProfileVersion: 1, Inputs: Values{"position": 1}}}, Options{})
	expectRule(t, err, "input-signal")
	s := simulate(t, Config{DeviceID: "v", Name: "XV", Profile: "VALVE", ProfileVersion: 1, Inputs: Values{"open": 1}, Parameters: params(t, map[string]any{"travelTimeS": 1})})
	run(t, s, 2)
	if outputs(t, s, "v")["opened"] != 1 {
		t.Fatal("initial inputs ignored")
	}
}
