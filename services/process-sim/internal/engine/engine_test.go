package engine

import (
	"errors"
	"io"
	"log/slog"
	"reflect"
	"testing"
	"time"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func pump(id string, clock Clock) Config {
	return Config{
		ContractVersion: ContractVersion,
		InstanceID:      id,
		FactoryID:       "factory-1",
		ModuleType:      "PUMP_HOUSE",
		ModelType:       "PUMP_HOUSE",
		ModelVersion:    1,
		ConfigVersion:   1,
		TickMs:          100,
		Clock:           clock,
		Parameters:      map[string]float64{"ratedFlow": 100, "rampTimeS": 10},
		Inputs:          map[string]float64{"DUTY_RUN_CMD": 1},
	}
}

// expect fails the test on an error, so a result can be used in one expression.
type expect struct{ t *testing.T }

func (x expect) snapshot(snapshot Snapshot, err error) Snapshot {
	x.t.Helper()
	if err != nil {
		x.t.Fatal(err)
	}
	return snapshot
}

func (x expect) events(events []Event, err error) []Event {
	x.t.Helper()
	if err != nil {
		x.t.Fatal(err)
	}
	return events
}

func TestLoadRefusesWhatTheContractDoesNot(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 2)
	cases := map[string]func(c *Config){
		"other contract":  func(c *Config) { c.ContractVersion = 2 },
		"no factory":      func(c *Config) { c.FactoryID = "" },
		"tick too small":  func(c *Config) { c.TickMs = 5 },
		"unknown clock":   func(c *Config) { c.Clock = "cron" },
		"unknown model":   func(c *Config) { c.ModelType = "BOILER" },
		"other model ver": func(c *Config) { c.ModelVersion = 2 },
		"bad parameter":   func(c *Config) { c.Parameters = map[string]float64{"ratedFlow": -1} },
		"unknown input":   func(c *Config) { c.Inputs = map[string]float64{"HEATER_ENABLE": 1} },
		"no version":      func(c *Config) { c.ConfigVersion = 0 },
	}
	for name, change := range cases {
		config := pump("p", ClockManual)
		change(&config)
		var configErr *ConfigError
		if _, err := e.Load(config); !errors.As(err, &configErr) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if len(e.List()) != 0 {
		t.Fatal("a refused configuration must not be kept")
	}
	// The instance limit holds.
	x.snapshot(e.Load(pump("a", ClockManual)))
	x.snapshot(e.Load(pump("b", ClockManual)))
	if _, err := e.Load(pump("c", ClockManual)); err == nil {
		t.Fatal("the third instance must be refused")
	}
	// Loading an id again replaces it and does not count twice.
	x.snapshot(e.Load(pump("a", ClockManual)))
	if got := e.Metrics().Instances; got != 2 {
		t.Fatalf("instances = %d", got)
	}
}

func TestManualInstancesStepDeterministicallyAndIndependently(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 10)
	first := x.snapshot(e.Load(pump("first", ClockManual)))
	if first.Status != StatusLoaded || first.Tick != 0 || first.Inputs["DUTY_RUN_CMD"] != 1 {
		t.Fatalf("loaded: %+v", first)
	}
	x.snapshot(e.Load(pump("second", ClockManual)))

	// LOADED does not step: the instance has to be started.
	var stateErr *StateError
	if _, err := e.Step("first", 1); !errors.As(err, &stateErr) {
		t.Fatalf("step before start: %v", err)
	}
	x.snapshot(e.Start("first"))
	x.snapshot(e.Start("second"))

	after := x.snapshot(e.Step("first", 50)) // 5 s of a 10 s ramp
	if after.Tick != 50 || after.TimeS != 5 || after.Outputs["DUTY_SPEED"] != 50 || after.Outputs["FLOW"] != 50 {
		t.Fatalf("after 50 ticks: %+v", after)
	}
	// The other instance did not move, and nothing moves by itself for a manual clock.
	time.Sleep(250 * time.Millisecond)
	if snapshot := x.snapshot(e.Inspect("second")); snapshot.Tick != 0 {
		t.Fatalf("second moved on its own: %+v", snapshot)
	}
	if snapshot := x.snapshot(e.Inspect("first")); snapshot.Tick != 50 {
		t.Fatalf("first moved on its own: %+v", snapshot)
	}

	// The same steps on the other instance give byte-equal outputs and state.
	other := x.snapshot(e.Step("second", 50))
	if !reflect.DeepEqual(other.Outputs, after.Outputs) || !reflect.DeepEqual(other.State, after.State) {
		t.Fatalf("not deterministic: %v vs %v", other.Outputs, after.Outputs)
	}

	// Inputs change what follows; an unknown input is refused.
	x.snapshot(e.SetInputs("first", map[string]float64{"DUTY_RUN_CMD": 0}))
	if _, err := e.SetInputs("first", map[string]float64{"LEVEL": 1}); err == nil {
		t.Fatal("unknown input accepted")
	}
	stopped := x.snapshot(e.Step("first", 50))
	if stopped.Outputs["DUTY_SPEED"] != 0 || stopped.Outputs["DUTY_RUNNING"] != 0 {
		t.Fatalf("after run command off: %+v", stopped)
	}
	events := x.events(e.Events("first", 0))
	if len(events) != 2 || events[0].Type != "PUMP_STARTED" || events[0].Tick != 1 || events[1].Type != "PUMP_STOPPED" || events[1].Seq != 2 {
		t.Fatalf("events: %+v", events)
	}
	if later := x.events(e.Events("first", 1)); len(later) != 1 || later[0].Seq != 2 {
		t.Fatalf("events after 1: %+v", later)
	}
}

func TestStopKeepsStateAndResetReturnsToTheStart(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 10)
	x.snapshot(e.Load(pump("p", ClockManual)))
	x.snapshot(e.Start("p"))
	x.snapshot(e.Step("p", 30))

	stopped := x.snapshot(e.Stop("p"))
	if stopped.Status != StatusStopped || stopped.Tick != 30 || stopped.Outputs["DUTY_SPEED"] != 30 {
		t.Fatalf("stopped: %+v", stopped)
	}
	var stateErr *StateError
	if _, err := e.Step("p", 1); !errors.As(err, &stateErr) {
		t.Fatal("a stopped instance must not step")
	}
	// Start continues where it stopped.
	x.snapshot(e.Start("p"))
	if continued := x.snapshot(e.Step("p", 10)); continued.Tick != 40 || continued.Outputs["DUTY_SPEED"] != 40 {
		t.Fatalf("continued: %+v", continued)
	}

	reset := x.snapshot(e.Reset("p"))
	if reset.Status != StatusLoaded || reset.Tick != 0 || reset.TimeS != 0 || len(reset.Outputs) != 0 || reset.Inputs["DUTY_RUN_CMD"] != 1 || reset.State["speed"] != 0 {
		t.Fatalf("reset: %+v", reset)
	}
	// The events are kept, with the reset recorded; the next run starts from tick zero again.
	events := x.events(e.Events("p", 0))
	if events[len(events)-1].Type != "RESET" {
		t.Fatalf("events after reset: %+v", events)
	}
	x.snapshot(e.Start("p"))
	if again := x.snapshot(e.Step("p", 30)); again.Tick != 30 || !reflect.DeepEqual(again.Outputs, stopped.Outputs) {
		t.Fatalf("after reset and the same steps: %+v", again)
	}
	// Unload forgets it.
	if err := e.Unload("p"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Inspect("p"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after unload: %v", err)
	}
	if err := e.Unload("p"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unload twice: %v", err)
	}
}

func TestWallClockInstancesTickOnTheirOwnUntilStopped(t *testing.T) {
	x := expect{t}
	e := New(quiet(), 10)
	config := pump("w", ClockWall)
	config.TickMs = 10
	x.snapshot(e.Load(config))
	x.snapshot(e.Start("w"))
	deadline := time.Now().Add(2 * time.Second)
	for {
		if x.snapshot(e.Inspect("w")).Tick >= 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the instance did not tick")
		}
		time.Sleep(5 * time.Millisecond)
	}
	stopped := x.snapshot(e.Stop("w"))
	time.Sleep(50 * time.Millisecond)
	if again := x.snapshot(e.Inspect("w")); again.Tick != stopped.Tick {
		t.Fatalf("ticked after stop: %d -> %d", stopped.Tick, again.Tick)
	}
	if e.Metrics().TicksTotal < 5 || e.Metrics().ByStatus[StatusStopped] != 1 {
		t.Fatalf("metrics: %+v", e.Metrics())
	}
	// Shutdown halts what runs; the instance is still known.
	x.snapshot(e.Start("w"))
	e.Shutdown()
	if len(e.List()) != 1 {
		t.Fatal("shutdown must keep the instances")
	}
}
