package engine

import (
	"errors"
	"testing"
)

func ptr(value float64) *float64 { return &value }

func (x expect) state(state SignalState, err error) SignalState {
	x.t.Helper()
	if err != nil {
		x.t.Fatal(err)
	}
	return state
}

func refused(t *testing.T, err error) {
	t.Helper()
	var configErr *ConfigError
	if !errors.As(err, &configErr) {
		t.Fatalf("expected a refusal, got %v", err)
	}
}

func TestManualOverrideReplacesTheDeliveredValueAndAutoResumes(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 2)
	x.snapshot(e.Load(pump("p1", ClockManual)))
	x.snapshot(e.Start("p1"))
	running := x.snapshot(e.Step("p1", 200))
	calculated := running.Outputs["DISCHARGE_PRESSURE"]
	if calculated <= 0 {
		t.Fatalf("pump not running: %v", running.Outputs)
	}

	state := x.state(e.SetOverride("p1", "DISCHARGE_PRESSURE", OverrideRequest{Mode: ModeManual, Value: ptr(9.5), Source: "tester"}))
	if state.Mode != ModeManual || state.Effective != 9.5 || state.Calculated != calculated || state.Source != "tester" {
		t.Fatalf("unexpected state %+v", state)
	}
	// It holds through ticks: the model keeps calculating, the PLC gets the override.
	after := x.snapshot(e.Step("p1", 50))
	if after.Outputs["DISCHARGE_PRESSURE"] != 9.5 {
		t.Fatalf("override not delivered: %v", after.Outputs)
	}
	if len(after.Overrides) != 1 || after.Overrides[0].Calculated != calculated {
		t.Fatalf("snapshot overrides %+v", after.Overrides)
	}
	// Other outputs are untouched.
	if after.Outputs["FLOW"] != running.Outputs["FLOW"] {
		t.Fatalf("flow changed: %v", after.Outputs)
	}
	// Stop and start keep it; the model's own alarm still follows the calculated value.
	x.snapshot(e.Stop("p1"))
	x.snapshot(e.Start("p1"))
	if x.snapshot(e.Inspect("p1")).Outputs["DISCHARGE_PRESSURE"] != 9.5 {
		t.Fatal("override lost on stop/start")
	}

	cleared := x.state(e.ClearOverride("p1", "DISCHARGE_PRESSURE", "tester"))
	if cleared.Mode != ModeAuto || cleared.Effective != calculated {
		t.Fatalf("cleared state %+v", cleared)
	}
	// Clearing again changes nothing and is not an error.
	x.state(e.ClearOverride("p1", "DISCHARGE_PRESSURE", ""))
	events := x.events(e.Events("p1", 0))
	var types []string
	for _, event := range events {
		types = append(types, event.Type)
	}
	if count(types, "OVERRIDE_SET") != 1 || count(types, "OVERRIDE_CLEARED") != 1 {
		t.Fatalf("events %v", types)
	}
}

func count(values []string, wanted string) int {
	n := 0
	for _, value := range values {
		if value == wanted {
			n++
		}
	}
	return n
}

func TestScenarioFollowsItsProfileOverSimulatedTime(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 2)
	x.snapshot(e.Load(tankConfigFor("t1")))
	x.snapshot(e.Start("t1"))
	x.snapshot(e.Step("t1", 1))
	x.state(e.SetOverride("t1", "LEVEL", OverrideRequest{Mode: ModeScenario, Profile: &Profile{Kind: "RAMP", From: 10, To: 90, DurationS: 8}}))
	// Ten ticks of 100 ms: one second of an eight-second ramp from 10 to 90.
	if level := x.snapshot(e.Step("t1", 10)).Outputs["LEVEL"]; level != 20 {
		t.Fatalf("ramp after 1 s: %v", level)
	}
	if level := x.snapshot(e.Step("t1", 200)).Outputs["LEVEL"]; level != 90 {
		t.Fatalf("ramp held at its end: %v", level)
	}
	steps := &Profile{Kind: "STEPS", Steps: []ProfileStep{{AtS: 0, Value: 0}, {AtS: 2, Value: 1}}}
	x.state(e.SetOverride("t1", "HIGH_LEVEL", OverrideRequest{Mode: ModeScenario, Profile: steps}))
	if x.snapshot(e.Step("t1", 10)).Outputs["HIGH_LEVEL"] != 0 {
		t.Fatal("switch before its step")
	}
	if x.snapshot(e.Step("t1", 15)).Outputs["HIGH_LEVEL"] != 1 {
		t.Fatal("switch after its step")
	}
	// A reset ends the run and its test state.
	reset := x.snapshot(e.Reset("t1"))
	if len(reset.Overrides) != 0 {
		t.Fatalf("overrides survived a reset: %+v", reset.Overrides)
	}
}

func tankConfigFor(id string) Config {
	config := pump(id, ClockManual)
	config.ModuleType, config.ModelType = "TANK", "TANK"
	config.Parameters = map[string]float64{"volume": 40}
	config.Inputs = map[string]float64{"INLET_VALVE_CMD": 1}
	return config
}

func TestOverrideRefusesWhatIsNotAMeasuredValue(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 2)
	x.snapshot(e.Load(pump("p1", ClockManual)))
	_, err := e.SetOverride("p1", "DUTY_RUN_CMD", OverrideRequest{Mode: ModeManual, Value: ptr(1)})
	refused(t, err) // a command the PLC gives
	_, err = e.SetOverride("p1", "LOW_PRESSURE", OverrideRequest{Mode: ModeManual, Value: ptr(1)})
	refused(t, err) // the model's own alarm
	_, err = e.SetOverride("p1", "DUTY_RUNNING", OverrideRequest{Mode: ModeManual, Value: ptr(1)})
	refused(t, err) // an actuator's state
	if _, err = e.SetOverride("p1", "NOPE", OverrideRequest{Mode: ModeManual, Value: ptr(1)}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown signal: %v", err)
	}
	if _, err = e.SetOverride("missing", "FLOW", OverrideRequest{Mode: ModeManual, Value: ptr(1)}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown instance: %v", err)
	}
	cases := map[string]OverrideRequest{
		"above range":       {Mode: ModeManual, Value: ptr(13)},
		"below range":       {Mode: ModeManual, Value: ptr(-1)},
		"no value":          {Mode: ModeManual},
		"unknown mode":      {Mode: "FORCED", Value: ptr(1)},
		"scenario no prof":  {Mode: ModeScenario},
		"ramp out of range": {Mode: ModeScenario, Profile: &Profile{Kind: "RAMP", From: 0, To: 50, DurationS: 5}},
		"ramp no duration":  {Mode: ModeScenario, Profile: &Profile{Kind: "RAMP", From: 0, To: 5}},
		"steps late start":  {Mode: ModeScenario, Profile: &Profile{Kind: "STEPS", Steps: []ProfileStep{{AtS: 1, Value: 1}}}},
		"steps backwards":   {Mode: ModeScenario, Profile: &Profile{Kind: "STEPS", Steps: []ProfileStep{{AtS: 0, Value: 1}, {AtS: 0, Value: 2}}}},
	}
	for name, request := range cases {
		if _, err := e.SetOverride("p1", "DISCHARGE_PRESSURE", request); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A switch is on or off.
	_, err = e.SetOverride("p1", "DISCHARGE_VALVE_OPEN", OverrideRequest{Mode: ModeManual, Value: ptr(0.5)})
	refused(t, err)
	// The ranges follow the parameters: rated 6 bar by default, so up to 12 bar.
	x.state(e.SetOverride("p1", "DISCHARGE_PRESSURE", OverrideRequest{Mode: ModeManual, Value: ptr(12)}))
	listed, err := e.Overrides("p1")
	if err != nil || len(listed) != 3 {
		t.Fatalf("overrides %v %v", listed, err)
	}
	if listed[0].Signal != "DISCHARGE_PRESSURE" || listed[0].Mode != ModeManual || listed[1].Mode != ModeAuto {
		t.Fatalf("listing %+v", listed)
	}
}
