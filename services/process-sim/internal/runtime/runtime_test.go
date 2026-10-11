package runtime

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func raw(value any) json.RawMessage {
	out, _ := json.Marshal(value)
	return out
}

// chain is a VFD → motor → pump with a pressure transmitter, under the factory's id.
func chain(factoryID string, clock Clock) Config {
	return Config{
		ContractVersion: ContractVersion,
		FactoryID:       factoryID,
		ConfigVersion:   1,
		TickMs:          100,
		Clock:           clock,
		Devices: []device.Config{
			{DeviceID: "vfd", Name: "VFD-01", Profile: "VFD", ProfileVersion: 1, Inputs: device.Values{"run": 1, "frequencySetpoint": 50}},
			{DeviceID: "motor", Name: "M-01", Profile: "MOTOR", ProfileVersion: 1, Links: map[string]string{"drive": "vfd"}},
			{DeviceID: "pump", Name: "P-01", Profile: "PUMP", ProfileVersion: 1, Links: map[string]string{"motor": "motor"}},
			{DeviceID: "pt", Name: "PT-01", Profile: "SENSOR", ProfileVersion: 1, Parameters: raw(map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "pressure"}}), Links: map[string]string{"measures": "pump"}},
		},
	}
}

// snap, dev and evs fail the test on an error, so a result can be used in one expression.
func snap(t *testing.T) func(Snapshot, error) Snapshot {
	return func(value Snapshot, err error) Snapshot {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func dev(t *testing.T) func(device.Snapshot, error) device.Snapshot {
	return func(value device.Snapshot, err error) device.Snapshot {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func evs(t *testing.T) func([]device.Event, error) []device.Event {
	return func(value []device.Event, err error) []device.Event {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func expectRule(t *testing.T, err error, rule string) {
	t.Helper()
	var configErr *ConfigError
	var stateErr *StateError
	switch {
	case errors.As(err, &configErr) && configErr.Rule == rule:
	case errors.As(err, &stateErr) && stateErr.Rule == rule:
	default:
		t.Fatalf("expected rule %s, got %v", rule, err)
	}
}

func TestLoadRefusesWhatTheContractDoesNot(t *testing.T) {
	r := New(quiet(), 100, device.Options{})
	cases := map[string]func(c *Config){
		"contract-version": func(c *Config) { c.ContractVersion = 2 },
		"factory-identity": func(c *Config) { c.FactoryID = "" },
		"tick":             func(c *Config) { c.TickMs = 5 },
		"clock":            func(c *Config) { c.Clock = "cron" },
		"config-version":   func(c *Config) { c.ConfigVersion = 0 },
		"profile":          func(c *Config) { c.Devices[0].Profile = "BOILER" },
		"one-motor-per-drive": func(c *Config) {
			c.Devices = append(c.Devices, device.Config{DeviceID: "m2", Name: "M-02", Profile: "MOTOR", ProfileVersion: 1, Links: map[string]string{"drive": "vfd"}})
		},
	}
	for rule, mutate := range cases {
		config := chain("f-1", ClockManual)
		mutate(&config)
		_, err := r.Load(config)
		expectRule(t, err, rule)
	}
	if len(r.List()) != 0 {
		t.Fatal("a refused configuration was kept")
	}
}

func TestLifecycleAndDeterminism(t *testing.T) {
	r := New(quiet(), 100, device.Options{})
	loaded := snap(t)(r.Load(chain("f-1", ClockManual)))
	if loaded.Status != StatusLoaded || loaded.Tick != 0 || loaded.DeviceCount != 4 || loaded.DevicesByStatus[device.StatusOK] != 4 {
		t.Fatalf("loaded %+v", loaded.Summary)
	}
	_, err := r.Step("f-1", 1)
	expectRule(t, err, "factory-state")
	snap(t)(r.Start("f-1"))
	stepped := snap(t)(r.Step("f-1", 100))
	if stepped.Tick != 100 || stepped.TimeS != 10 {
		t.Fatalf("stepped %+v", stepped.Summary)
	}
	pump := dev(t)(r.Device("f-1", "pump"))
	if pump.Outputs["running"] != 1 || pump.Outputs["flow"] != 100 {
		t.Fatalf("pump %+v", pump)
	}
	// The same configuration stepped the same way gives the same devices.
	snap(t)(r.Load(chain("f-2", ClockManual)))
	snap(t)(r.Start("f-2"))
	other := snap(t)(r.Step("f-2", 100))
	if !reflect.DeepEqual(other.Devices, stepped.Devices) {
		t.Fatal("not deterministic across factories")
	}
	// Stop keeps the state; start continues; reset starts over.
	stopped := snap(t)(r.Stop("f-1"))
	if stopped.Status != StatusStopped || stopped.Tick != 100 {
		t.Fatalf("stopped %+v", stopped.Summary)
	}
	snap(t)(r.Start("f-1"))
	if snap(t)(r.Step("f-1", 10)).Tick != 110 {
		t.Fatal("did not continue")
	}
	reset := snap(t)(r.Reset("f-1"))
	if reset.Status != StatusLoaded || reset.Tick != 0 || dev(t)(r.Device("f-1", "pump")).Outputs["flow"] != 0 {
		t.Fatalf("reset %+v", reset.Summary)
	}
	events := evs(t)(r.Events("f-1", 0))
	if events[len(events)-1].Type != "RESET" {
		t.Fatalf("events %+v", events)
	}
	snap(t)(r.Start("f-1"))
	again := snap(t)(r.Step("f-1", 100))
	if !reflect.DeepEqual(again.Devices, stepped.Devices) {
		t.Fatal("not deterministic after a reset")
	}
	// Events are numbered and only those after a sequence are returned.
	all := evs(t)(r.Events("f-1", 0))
	later := evs(t)(r.Events("f-1", all[2].Seq))
	if len(later) != len(all)-3 || all[0].Seq != 1 {
		t.Fatalf("events %d / %d", len(later), len(all))
	}
	if err := r.Unload("f-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Inspect("f-2"); !errors.Is(err, ErrNotFound) {
		t.Fatal("unloaded factory still there")
	}
	if list := r.List(); len(list) != 1 || list[0].FactoryID != "f-1" {
		t.Fatalf("list %+v", list)
	}
}

func TestInputsFaultsForcingAndDynamicDevices(t *testing.T) {
	r := New(quiet(), 100, device.Options{})
	snap(t)(r.Load(chain("f-1", ClockManual)))
	snap(t)(r.Start("f-1"))
	snap(t)(r.Step("f-1", 80))
	_, err := r.SetInputs("f-1", "vfd", device.Values{"flow": 1})
	expectRule(t, err, "input-signal")
	dev(t)(r.SetInputs("f-1", "vfd", device.Values{"run": 0}))
	snap(t)(r.Step("f-1", 200))
	if dev(t)(r.Device("f-1", "motor")).Outputs["running"] != 0 {
		t.Fatal("the run command was not taken")
	}

	injected := dev(t)(r.InjectFault("f-1", "pump", "DRY_RUN"))
	if !reflect.DeepEqual(injected.ActiveFaults, []string{"DRY_RUN"}) {
		t.Fatalf("injected %+v", injected)
	}
	_, err = r.InjectFault("f-1", "pump", "DRY_RUN")
	expectRule(t, err, "fault-active")
	dev(t)(r.ClearFault("f-1", "pump", "DRY_RUN"))
	_, err = r.ResetDevice("f-1", "missing")
	if !errors.Is(err, device.ErrNotFound) {
		t.Fatalf("missing device: %v", err)
	}
	nine := 9.0
	forced := dev(t)(r.Force("f-1", "pt", &nine))
	if forced.Forced == nil || *forced.Forced != 9 {
		t.Fatalf("forced %+v", forced)
	}
	snap(t)(r.Step("f-1", 1))
	if dev(t)(r.Device("f-1", "pt")).Outputs["value"] != 9 {
		t.Fatal("forced value not delivered")
	}
	released := dev(t)(r.Force("f-1", "pt", nil))
	if released.Forced != nil {
		t.Fatal("not released")
	}
	types := map[string]bool{}
	for _, event := range evs(t)(r.Events("f-1", 0)) {
		types[event.Type] = true
	}
	for _, want := range []string{"FAULT_INJECTED", "FAULT_CLEARED", "SIMULATED_INPUT_FORCED", "SIMULATED_INPUT_RELEASED", "VFD_STATE_CHANGED"} {
		if !types[want] {
			t.Fatalf("no %s event in %v", want, types)
		}
	}

	// A device joins a running factory and leaves it; the configuration follows, so a reset rebuilds it.
	snap(t)(r.Upsert("f-1", device.Config{DeviceID: "xv", Name: "XV-01", Profile: "VALVE", ProfileVersion: 1, Inputs: device.Values{"open": 1}}))
	snap(t)(r.Step("f-1", 60))
	if dev(t)(r.Device("f-1", "xv")).Outputs["opened"] != 1 {
		t.Fatal("the new valve did not move")
	}
	_, err = r.RemoveDevice("f-1", "motor")
	expectRule(t, err, "linked-device")
	snap(t)(r.RemoveDevice("f-1", "xv"))
	if _, err := r.Device("f-1", "xv"); !errors.Is(err, device.ErrNotFound) {
		t.Fatal("removed device still there")
	}
	snap(t)(r.Upsert("f-1", device.Config{DeviceID: "xv", Name: "XV-01", Profile: "VALVE", ProfileVersion: 1}))
	snap(t)(r.Reset("f-1"))
	if snap(t)(r.Inspect("f-1")).DeviceCount != 5 {
		t.Fatal("the reset lost the device added later")
	}
}

func TestDeviceLimitsAndIsolationBetweenFactories(t *testing.T) {
	r := New(quiet(), 6, device.Options{})
	snap(t)(r.Load(chain("f-1", ClockManual)))
	_, err := r.Load(chain("f-2", ClockManual))
	expectRule(t, err, "device-limit")
	small := chain("f-2", ClockManual)
	small.Devices = small.Devices[:2]
	snap(t)(r.Load(small))
	_, err = r.Upsert("f-2", device.Config{DeviceID: "x", Name: "X", Profile: "VALVE", ProfileVersion: 1})
	expectRule(t, err, "device-limit")
	// Replacing a factory frees its devices first.
	snap(t)(r.Load(small))
	metrics := r.Metrics()
	if metrics.Factories != 2 || metrics.Devices != 6 || metrics.MaxDevices != 6 || len(metrics.Profiles) < 10 {
		t.Fatalf("metrics %+v", metrics)
	}
	// Stepping one factory moves no other.
	snap(t)(r.Start("f-1"))
	snap(t)(r.Step("f-1", 5))
	if snap(t)(r.Inspect("f-2")).Tick != 0 {
		t.Fatal("factory 2 moved")
	}
}

func TestWallClockTicksAndStallDetection(t *testing.T) {
	r := New(quiet(), 100, device.Options{})
	config := chain("f-1", ClockWall)
	config.TickMs = 10
	snap(t)(r.Load(config))
	snap(t)(r.Start("f-1"))
	deadline := time.Now().Add(5 * time.Second)
	for snap(t)(r.Inspect("f-1")).Tick < 5 {
		if time.Now().After(deadline) {
			t.Fatal("the wall clock did not tick")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snap(t)(r.Inspect("f-1")).Stalled {
		t.Fatal("a ticking factory is not stalled")
	}
	// A factory whose ticks stopped arriving reports it: the clock is moved instead of waiting.
	factory, _ := r.get("f-1")
	r.now = func() time.Time { return time.Now().Add(time.Second) }
	factory.mu.Lock()
	factory.lastTickAt = time.Now().Add(-time.Second)
	stalled := factory.snapshotLocked(r.now()).Stalled
	factory.mu.Unlock()
	if !stalled {
		t.Fatal("stall not reported")
	}
	r.Shutdown()
	if snap(t)(r.Inspect("f-1")).Status != StatusRunning {
		t.Fatal("shutdown keeps the status for the record")
	}
}
