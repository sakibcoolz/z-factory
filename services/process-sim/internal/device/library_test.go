package device

import "testing"

// The behaviour library of TASK-1011: switching and thermal devices.

func TestRelayPicksUpDropsOutAndFeedsAMotor(t *testing.T) {
	s := simulate(t,
		config("k1", "K1", "RELAY", map[string]any{"pickupTimeS": 0.25, "dropoutTimeS": 0.15}, nil),
		config("m", "M", "MOTOR", nil, map[string]string{"drive": "k1"}),
	)
	if outputs(t, s, "k1")["auxNc"] != 1 || outputs(t, s, "k1")["closed"] != 0 {
		t.Fatalf("open relay: %v", outputs(t, s, "k1"))
	}
	inputs(t, s, "k1", Values{"coil": 1})
	run(t, s, 0.2)
	if outputs(t, s, "k1")["closed"] != 0 || s.devices["k1"].state != "PICKING_UP" {
		t.Fatalf("after 0.2 s: %v %s", outputs(t, s, "k1"), s.devices["k1"].state)
	}
	run(t, s, 0.1)
	if outputs(t, s, "k1")["closed"] != 1 || outputs(t, s, "k1")["auxNo"] != 1 || outputs(t, s, "k1")["auxNc"] != 0 {
		t.Fatalf("after pickup: %v", outputs(t, s, "k1"))
	}
	// The motor is energized through the contacts at line frequency.
	run(t, s, 3)
	if outputs(t, s, "m")["running"] != 1 {
		t.Fatalf("motor not running: %v", outputs(t, s, "m"))
	}
	near(t, outputs(t, s, "m")["actualSpeed"], 1450, 5, "speed at line frequency")

	inputs(t, s, "k1", Values{"coil": 0})
	run(t, s, 0.1)
	if outputs(t, s, "k1")["closed"] != 1 || s.devices["k1"].state != "DROPPING_OUT" {
		t.Fatalf("during dropout: %v %s", outputs(t, s, "k1"), s.devices["k1"].state)
	}
	run(t, s, 0.1)
	if outputs(t, s, "k1")["closed"] != 0 || outputs(t, s, "m")["running"] != 0 {
		t.Fatalf("after dropout: %v %v", outputs(t, s, "k1"), outputs(t, s, "m"))
	}

	// Welded contacts stay closed whatever the coil does; an open coil never closes them.
	if _, err := s.InjectFault("k1", "WELDED_CONTACTS"); err != nil {
		t.Fatal(err)
	}
	run(t, s, 0.1)
	if outputs(t, s, "k1")["closed"] != 1 || s.devices["k1"].state != "CLOSED" {
		t.Fatalf("welded: %v", outputs(t, s, "k1"))
	}
	if _, err := s.ClearFault("k1", "WELDED_CONTACTS"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InjectFault("k1", "COIL_OPEN"); err != nil {
		t.Fatal(err)
	}
	inputs(t, s, "k1", Values{"coil": 1})
	run(t, s, 1)
	if outputs(t, s, "k1")["closed"] != 0 || s.devices["k1"].state != "OPEN" {
		t.Fatalf("coil open: %v %s", outputs(t, s, "k1"), s.devices["k1"].state)
	}

	// A solid-state relay switches in the step it is commanded.
	ssr := simulate(t, config("ssr", "SSR", "RELAY", map[string]any{"kind": "SOLID_STATE", "pickupTimeS": 5}, nil))
	inputs(t, ssr, "ssr", Values{"coil": 1})
	run(t, ssr, tick)
	if outputs(t, ssr, "ssr")["closed"] != 1 {
		t.Fatalf("solid state: %v", outputs(t, ssr, "ssr"))
	}

	// A relay can feed one motor only; a motor cannot be fed by a heater.
	_, err := NewSimulation("f", []Config{
		config("k", "K", "RELAY", nil, nil),
		config("m1", "M1", "MOTOR", nil, map[string]string{"drive": "k"}),
		config("m2", "M2", "MOTOR", nil, map[string]string{"drive": "k"}),
	}, Options{})
	expectRule(t, err, "one-motor-per-drive")
	_, err = NewSimulation("f", []Config{
		config("h", "H", "HEATER", nil, nil),
		config("m1", "M1", "MOTOR", nil, map[string]string{"drive": "h"}),
	}, Options{})
	expectRule(t, err, "drive")
}

func TestHeaterWarmsCoolsCutsOutAndFails(t *testing.T) {
	params := map[string]any{"ratedPowerKw": 2, "ambientC": 20, "riseAtFullPowerC": 100, "timeConstantS": 10, "maxTemperatureC": 90, "cutoutHysteresisC": 20}
	s := simulate(t,
		config("k1", "K1", "RELAY", map[string]any{"kind": "SOLID_STATE"}, nil),
		config("h", "H", "HEATER", params, map[string]string{"contactor": "k1"}),
		config("tt", "TT", "SENSOR", map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "temperature"}}, map[string]string{"measures": "h"}),
	)
	near(t, outputs(t, s, "h")["temperature"], 20, 1e-9, "rests at ambient")
	if outputs(t, s, "h")["heating"] != 0 || s.devices["h"].state != "OFF" {
		t.Fatalf("off: %v", outputs(t, s, "h"))
	}
	// The on command does nothing while the heater has a contactor; the contactor does.
	inputs(t, s, "h", Values{"on": 1})
	run(t, s, 1)
	if outputs(t, s, "h")["heating"] != 0 {
		t.Fatalf("on command bypassed the contactor: %v", outputs(t, s, "h"))
	}
	inputs(t, s, "k1", Values{"coil": 1})
	run(t, s, 10)
	// One time constant at full power: 63 % of the rise, and the transmitter follows.
	near(t, outputs(t, s, "h")["temperature"], 20+100*0.632, 1.5, "after one time constant")
	near(t, outputs(t, s, "tt")["value"], outputs(t, s, "h")["temperature"], 1e-9, "transmitter reads the element")
	near(t, outputs(t, s, "h")["powerOutput"], 2, 1e-9, "full power")
	if s.devices["h"].state != "HEATING" {
		t.Fatalf("state %s", s.devices["h"].state)
	}
	// Towards the cutout: no power above 90 °C, back once it has cooled to 70 °C.
	run(t, s, 20)
	if outputs(t, s, "h")["cutout"] != 1 || outputs(t, s, "h")["heating"] != 0 || s.devices["h"].state != "CUTOUT" {
		t.Fatalf("cutout: %v %s", outputs(t, s, "h"), s.devices["h"].state)
	}
	if temperature := outputs(t, s, "h")["temperature"]; temperature > 92 {
		t.Fatalf("overshot the cutout: %g", temperature)
	}
	// It cools until the hysteresis is gone, then heats again: a thermostat cycle.
	steps := 0
	for outputs(t, s, "h")["cutout"] == 1 && steps < 200 {
		run(t, s, tick)
		steps++
	}
	if out := outputs(t, s, "h"); out["cutout"] != 0 || out["heating"] != 1 || out["temperature"] > 71 {
		t.Fatalf("after cooling by the hysteresis: %v", out)
	}
	// Half power halves the rise.
	inputs(t, s, "h", Values{"power": 50})
	run(t, s, 60)
	near(t, outputs(t, s, "h")["temperature"], 70, 1, "half power steady state")
	near(t, outputs(t, s, "h")["powerOutput"], 1, 1e-9, "half power")

	// A failed element takes no power and says nothing; the trip is reported and latches.
	if _, err := s.InjectFault("h", "ELEMENT_FAILURE"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if out := outputs(t, s, "h"); out["heating"] != 0 || out["faulted"] != 0 || out["powerOutput"] != 0 {
		t.Fatalf("element failure: %v", out)
	}
	if _, err := s.ClearFault("h", "ELEMENT_FAILURE"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InjectFault("h", "OVERTEMPERATURE"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if out := outputs(t, s, "h"); out["faulted"] != 1 || out["heating"] != 0 || s.devices["h"].state != "FAULTED" {
		t.Fatalf("tripped: %v %s", out, s.devices["h"].state)
	}
	if _, err := s.ClearFault("h", "OVERTEMPERATURE"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if outputs(t, s, "h")["faulted"] != 1 {
		t.Fatalf("the trip did not latch")
	}
	inputs(t, s, "h", Values{"power": 50, "faultReset": 1})
	run(t, s, tick)
	if out := outputs(t, s, "h"); out["faulted"] != 0 || out["heating"] != 1 {
		t.Fatalf("after reset: %v", out)
	}

	// Without a contactor the on command energizes it; the initial temperature is taken.
	direct := simulate(t, config("h", "H", "HEATER", map[string]any{"initialTemperatureC": 50, "timeConstantS": 10}, nil))
	near(t, outputs(t, direct, "h")["temperature"], 50, 1e-9, "initial temperature")
	inputs(t, direct, "h", Values{"on": 1})
	run(t, direct, tick)
	if outputs(t, direct, "h")["heating"] != 1 {
		t.Fatalf("direct: %v", outputs(t, direct, "h"))
	}
	_, err := NewSimulation("f", []Config{
		config("v", "V", "VALVE", nil, nil),
		config("h", "H", "HEATER", nil, map[string]string{"contactor": "v"}),
	}, Options{})
	expectRule(t, err, "contactor")
}

func TestIndicatorLampsFlashAndFail(t *testing.T) {
	s := simulate(t, config("hl", "HL", "INDICATOR", map[string]any{"flashRateHz": 2}, nil))
	if s.devices["hl"].state != "OFF" {
		t.Fatalf("state %s", s.devices["hl"].state)
	}
	inputs(t, s, "hl", Values{"red": 1, "buzzer": 1})
	run(t, s, tick)
	if out := outputs(t, s, "hl"); out["redLit"] != 1 || out["greenLit"] != 0 || out["buzzerOn"] != 1 || s.devices["hl"].state != "ON" {
		t.Fatalf("steady: %v %s", out, s.devices["hl"].state)
	}
	// Flashing at 2 Hz: lit in the first quarter second of every half second.
	inputs(t, s, "hl", Values{"green": 1, "flash": 1})
	lit := 0
	for step := 0; step < 10; step++ {
		run(t, s, tick)
		if outputs(t, s, "hl")["greenLit"] == 1 {
			lit++
		}
		if s.devices["hl"].state != "FLASHING" {
			t.Fatalf("state %s", s.devices["hl"].state)
		}
	}
	if lit < 4 || lit > 6 {
		t.Fatalf("lit %d of 10 steps while flashing", lit)
	}
	// A failed lamp set lights nothing and is not reported; the buzzer still sounds.
	if _, err := s.InjectFault("hl", "LAMP_FAILURE"); err != nil {
		t.Fatal(err)
	}
	inputs(t, s, "hl", Values{"green": 1, "buzzer": 1})
	run(t, s, tick)
	if out := outputs(t, s, "hl"); out["greenLit"] != 0 || out["buzzerOn"] != 1 || s.devices["hl"].state != "ON" {
		t.Fatalf("lamp failure: %v %s", out, s.devices["hl"].state)
	}
	if s.devices["hl"].Snapshot().Faulted != true {
		t.Fatalf("the snapshot should show the active fault")
	}
}
