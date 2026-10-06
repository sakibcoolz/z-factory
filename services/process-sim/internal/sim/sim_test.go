package sim

import (
	"reflect"
	"testing"
)

// run steps a fresh model n times with the same inputs and returns the last outputs and every event.
func run(t *testing.T, name string, params map[string]float64, inputs map[string]float64, dt float64, n int) (map[string]float64, []Event, Model) {
	t.Helper()
	model, err := New(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := model.Reset(params); err != nil {
		t.Fatal(err)
	}
	var outputs map[string]float64
	var events []Event
	for i := 0; i < n; i++ {
		var stepEvents []Event
		outputs, stepEvents = model.Step(dt, inputs)
		events = append(events, stepEvents...)
	}
	return outputs, events, model
}

func TestModelsAreRegisteredWithTheirContract(t *testing.T) {
	if got := Types(); !reflect.DeepEqual(got, []string{"PUMP_HOUSE", "TANK"}) {
		t.Fatalf("types = %v", got)
	}
	for _, name := range Types() {
		model, _ := New(name)
		if model.Version() != 1 || len(model.Inputs()) == 0 || len(model.Outputs()) == 0 || len(model.Parameters()) == 0 {
			t.Errorf("%s: incomplete contract", name)
		}
		if err := model.Reset(nil); err != nil {
			t.Errorf("%s: defaults do not reset: %v", name, err)
		}
		outputs, _ := model.Step(0.1, nil)
		for _, key := range model.Outputs() {
			if _, ok := outputs[key]; !ok {
				t.Errorf("%s: output %s missing", name, key)
			}
		}
	}
	if _, err := New("BOILER"); err == nil {
		t.Fatal("an unknown model type must be refused")
	}
}

func TestSameConfigurationAndInputsGiveTheSameResult(t *testing.T) {
	for _, name := range Types() {
		inputs := map[string]float64{"DUTY_RUN_CMD": 1, "DUTY_SPEED_SETPOINT": 80, "INLET_VALVE_CMD": 1, "AGITATOR_RUN_CMD": 1}
		params := map[string]float64{}
		first, firstEvents, firstModel := run(t, name, params, inputs, 0.1, 600)
		second, secondEvents, secondModel := run(t, name, params, inputs, 0.1, 600)
		if !reflect.DeepEqual(first, second) || !reflect.DeepEqual(firstEvents, secondEvents) || !reflect.DeepEqual(firstModel.State(), secondModel.State()) {
			t.Errorf("%s is not deterministic", name)
		}
	}
}

func TestPumpHouseRampsFlowAndPressureFromTheCommand(t *testing.T) {
	params := map[string]float64{"ratedFlow": 100, "ratedPressure": 4, "rampTimeS": 10}
	running := map[string]float64{"DUTY_RUN_CMD": 1}

	// Half the ramp: half speed, half flow, a quarter of the pressure (affinity law).
	outputs, events, model := run(t, "PUMP_HOUSE", params, running, 0.5, 10)
	want := map[string]float64{"DUTY_RUNNING": 1, "DUTY_SPEED": 50, "FLOW": 50, "DISCHARGE_PRESSURE": 1, "DISCHARGE_VALVE_OPEN": 1, "LOW_PRESSURE": 0}
	if !reflect.DeepEqual(outputs, want) {
		t.Fatalf("after 5 s: %v", outputs)
	}
	if len(events) != 1 || events[0].Type != "PUMP_STARTED" {
		t.Fatalf("events: %v", events)
	}
	// Full ramp and a setpoint of 50 %: the speed settles at the setpoint.
	for i := 0; i < 40; i++ {
		outputs, _ = model.Step(0.5, map[string]float64{"DUTY_RUN_CMD": 1, "DUTY_SPEED_SETPOINT": 50})
	}
	if outputs["DUTY_SPEED"] != 50 || outputs["FLOW"] != 50 {
		t.Fatalf("at setpoint: %v", outputs)
	}
	// A closed discharge valve stops the flow but not the pressure; stopping ramps down and reports it.
	for i := 0; i < 20; i++ {
		outputs, _ = model.Step(0.5, map[string]float64{"DUTY_RUN_CMD": 1, "DUTY_SPEED_SETPOINT": 50, "DISCHARGE_VALVE_CMD": 0})
	}
	if outputs["FLOW"] != 0 || outputs["DISCHARGE_PRESSURE"] != 1 || outputs["DISCHARGE_VALVE_OPEN"] != 0 {
		t.Fatalf("valve closed: %v", outputs)
	}
	var stopped bool
	for i := 0; i < 30; i++ {
		var stepEvents []Event
		outputs, stepEvents = model.Step(0.5, map[string]float64{"DUTY_RUN_CMD": 0})
		for _, event := range stepEvents {
			stopped = stopped || event.Type == "PUMP_STOPPED"
		}
	}
	if outputs["DUTY_RUNNING"] != 0 || outputs["DUTY_SPEED"] != 0 || !stopped {
		t.Fatalf("stopped: %v (event %v)", outputs, stopped)
	}
}

func TestPumpHouseRefusesParametersItDoesNotHaveOrCannotUse(t *testing.T) {
	model, _ := New("PUMP_HOUSE")
	for name, params := range map[string]map[string]float64{
		"unknown":   {"boilerPower": 1},
		"zero flow": {"ratedFlow": 0},
		"ratio > 1": {"lowPressureRatio": 2},
		"nan":       {"rampTimeS": nan()},
	} {
		if err := model.Reset(params); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestTankFillsDrainsAndAlarms(t *testing.T) {
	// 1 m3 at 3600 m3/h: 1 m3 per second, so 1 % per 10 ms tick; valves open at once.
	params := map[string]float64{"volume": 1, "inflowRate": 3600, "outflowRate": 3600, "valveTravelS": 0.01, "initialLevel": 50}
	outputs, _, model := run(t, "TANK", params, nil, 0.01, 1)
	if outputs["LEVEL"] != 50 || outputs["LEVEL_LOW"] != 0 || outputs["HIGH_LEVEL"] != 0 {
		t.Fatalf("initial: %v", outputs)
	}
	var raised []string
	for i := 0; i < 60; i++ {
		var events []Event
		outputs, events = model.Step(0.01, map[string]float64{"INLET_VALVE_CMD": 1})
		for _, event := range events {
			raised = append(raised, event.Type+" "+event.Message)
		}
	}
	// 50 % + 60 ticks of 1 %, less the one tick the valve took to open: full, high switch and alarm on.
	if outputs["LEVEL"] != 100 || outputs["HIGH_LEVEL"] != 1 || outputs["LEVEL_HIGH"] != 1 || outputs["INLET_VALVE_OPEN"] != 1 {
		t.Fatalf("filled: %v", outputs)
	}
	if !reflect.DeepEqual(raised, []string{"ALARM_RAISED level high"}) {
		t.Fatalf("events while filling: %v", raised)
	}
	for i := 0; i < 120; i++ {
		var events []Event
		outputs, events = model.Step(0.01, map[string]float64{"OUTLET_VALVE_CMD": 1})
		for _, event := range events {
			raised = append(raised, event.Type+" "+event.Message)
		}
	}
	if outputs["LEVEL"] != 0 || outputs["LEVEL_LOW"] != 1 || outputs["CONTENT"] != 0 {
		t.Fatalf("drained: %v", outputs)
	}
	if !reflect.DeepEqual(raised[1:], []string{"ALARM_CLEARED level high cleared", "ALARM_RAISED level low"}) {
		t.Fatalf("events while draining: %v", raised)
	}
	// Reset puts the initial level back.
	if err := model.Reset(params); err != nil {
		t.Fatal(err)
	}
	if model.State()["content"] != 0.5 {
		t.Fatalf("after reset: %v", model.State())
	}
}

func nan() float64 {
	zero := 0.0
	return zero / zero
}
