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

// Starters and servo (PR B).

func TestSoftStarterRampsAndLimitsTheMotor(t *testing.T) {
	s := simulate(t,
		config("q1", "Q1", "SOFT_STARTER", map[string]any{"initialVoltagePct": 40, "rampTimeS": 3, "rampDownTimeS": 1}, nil),
		config("m", "M", "MOTOR", map[string]any{"timeConstantS": 0.05}, map[string]string{"drive": "q1"}),
	)
	inputs(t, s, "q1", Values{"run": 1})
	run(t, s, 1)
	out := outputs(t, s, "q1")
	near(t, out["outputVoltage"], 60, 1.5, "voltage after a third of the ramp")
	if out["running"] != 1 || out["bypassed"] != 0 || s.devices["q1"].state != "RAMPING_UP" {
		t.Fatalf("ramping: %v %s", out, s.devices["q1"].state)
	}
	// The motor's speed is held to the voltage share meanwhile.
	near(t, outputs(t, s, "m")["actualSpeed"], 1450*0.6, 1450*0.03, "speed limited to the voltage share")
	run(t, s, 2.5)
	out = outputs(t, s, "q1")
	if out["bypassed"] != 1 || s.devices["q1"].state != "BYPASSED" {
		t.Fatalf("bypassed: %v %s", out, s.devices["q1"].state)
	}
	near(t, outputs(t, s, "m")["actualSpeed"], 1450, 5, "full speed at the bypass")
	near(t, out["outputCurrent"], outputs(t, s, "m")["current"], 1e-9, "the starter reports the motor's current")
	inputs(t, s, "q1", Values{"run": 0})
	run(t, s, 0.5)
	if s.devices["q1"].state != "RAMPING_DOWN" || outputs(t, s, "q1")["running"] != 1 {
		t.Fatalf("ramping down: %v %s", outputs(t, s, "q1"), s.devices["q1"].state)
	}
	run(t, s, 0.6)
	if s.devices["q1"].state != "STOPPED" || outputs(t, s, "m")["running"] != 0 {
		t.Fatalf("stopped: %v %v", outputs(t, s, "q1"), outputs(t, s, "m"))
	}
	// A trip removes the output at once and latches.
	inputs(t, s, "q1", Values{"run": 1})
	run(t, s, 4)
	if _, err := s.InjectFault("q1", "OVERTEMPERATURE"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if out := outputs(t, s, "q1"); out["outputVoltage"] != 0 || out["faulted"] != 1 || s.devices["q1"].state != "FAULTED" {
		t.Fatalf("tripped: %v", out)
	}
}

func TestMotorStarterTripsOnThermalOverloadFromItsOwnModel(t *testing.T) {
	// The setting is below the motor's current under load, so the relay heats up.
	s := simulate(t,
		config("f1", "F1", "MOTOR_STARTER", map[string]any{"overloadSettingA": 4, "tripClass": 10}, nil),
		config("m", "M", "MOTOR", map[string]any{"ratedCurrentA": 10, "timeConstantS": 0.05}, map[string]string{"drive": "f1"}),
		config("p", "P", "PUMP", nil, map[string]string{"motor": "m"}),
	)
	inputs(t, s, "f1", Values{"run": 1})
	run(t, s, 1)
	out := outputs(t, s, "f1")
	if out["running"] != 1 || out["current"] <= 4 || out["thermalLoad"] <= 0 || out["thermalLoad"] >= 100 {
		t.Fatalf("heating up: %v", out)
	}
	// Time to trip at this overload: tripClass × (7.2² − 1) / ((I/Iset)² − 1).
	ratio := out["current"] / 4
	expected := 10 * (7.2*7.2 - 1) / (ratio*ratio - 1)
	var events []Event
	tripped := 0.0
	for tripped == 0 && s.elapsedS < expected*2 {
		stepped, err := s.Step(tick)
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, stepped...)
		if s.devices["f1"].tripped {
			tripped = s.elapsedS
		}
	}
	if tripped == 0 {
		t.Fatalf("the relay never tripped")
	}
	near(t, tripped, expected+1, 1.5, "time to trip")
	raised := false
	for _, event := range events {
		if event.Type == "FAULT_RAISED" && event.DeviceID == "f1" && event.Payload["code"] == "OVERLOAD" {
			raised = true
		}
	}
	if !raised {
		t.Fatalf("no FAULT_RAISED event: %v", events)
	}
	run(t, s, tick)
	if out := outputs(t, s, "f1"); out["running"] != 0 || out["faulted"] != 1 || outputs(t, s, "m")["running"] != 0 {
		t.Fatalf("after the trip: %v %v", out, outputs(t, s, "m"))
	}
	// The model's fault stays until cleared like an injected one; the trip latches.
	if _, err := s.ClearFault("f1", "OVERLOAD"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if !s.devices["f1"].tripped {
		t.Fatalf("the trip did not latch")
	}
	inputs(t, s, "f1", Values{"run": 1, "faultReset": 1})
	run(t, s, tick)
	if outputs(t, s, "f1")["running"] != 1 {
		t.Fatalf("after reset: %v", outputs(t, s, "f1"))
	}
}

func TestServoDriveMovesTheServoMotorWithATrapezoidalProfile(t *testing.T) {
	s := simulate(t,
		config("sd", "SD", "SERVO_DRIVE", map[string]any{"maxVelocity": 100, "acceleration": 200, "deceleration": 200, "inPositionWindow": 0.5}, nil),
		config("sm", "SM", "SERVO_MOTOR", map[string]any{"ratedVelocity": 100}, map[string]string{"drive": "sd"}),
		config("enc", "ENC", "ENCODER", map[string]any{"pulsesPerRevolution": 100, "unitsPerRevolution": 10}, map[string]string{"measures": "sm"}),
	)
	// Disabled: nothing moves, the motor draws nothing.
	inputs(t, s, "sd", Values{"positionSetpoint": 100})
	run(t, s, 1)
	if out := outputs(t, s, "sd"); out["actualPosition"] != 0 || out["enabled"] != 0 || outputs(t, s, "sm")["current"] != 0 {
		t.Fatalf("disabled: %v %v", out, outputs(t, s, "sm"))
	}
	inputs(t, s, "sd", Values{"enable": 1, "positionSetpoint": 100})
	run(t, s, 0.3)
	out := outputs(t, s, "sd")
	near(t, out["actualVelocity"], 60, 1e-6, "accelerating at 200 units/s²")
	if out["moving"] != 1 || s.devices["sd"].state != "MOVING" || s.devices["sm"].state != "MOVING" {
		t.Fatalf("moving: %v %s %s", out, s.devices["sd"].state, s.devices["sm"].state)
	}
	// Accelerate 0.5 s (25 units), cruise, decelerate 0.5 s (25 units): 100 units in 1.5 s.
	run(t, s, 1.3)
	out = outputs(t, s, "sd")
	near(t, out["actualPosition"], 100, 1e-6, "arrived")
	if out["inPosition"] != 1 || out["actualVelocity"] != 0 || s.devices["sd"].state != "HOLDING" {
		t.Fatalf("holding: %v %s", out, s.devices["sd"].state)
	}
	motor := outputs(t, s, "sm")
	near(t, motor["actualPosition"], 100, 1e-6, "the motor follows the drive")
	near(t, motor["current"], 5*0.1, 1e-9, "holding current")
	// The encoder counted ten revolutions.
	near(t, outputs(t, s, "enc")["count"], 1000, 1e-9, "encoder count")
	// Back to zero, then a trip holds everything.
	inputs(t, s, "sd", Values{"enable": 1, "positionSetpoint": 0})
	run(t, s, 0.5)
	if outputs(t, s, "sd")["actualVelocity"] >= 0 {
		t.Fatalf("not moving back: %v", outputs(t, s, "sd"))
	}
	if _, err := s.InjectFault("sd", "FOLLOWING_ERROR"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if out := outputs(t, s, "sd"); out["enabled"] != 0 || out["faulted"] != 1 || out["actualVelocity"] != 0 {
		t.Fatalf("tripped: %v", out)
	}
	// A servo motor needs a servo drive; a plain motor cannot be on a servo drive.
	_, err := NewSimulation("f", []Config{
		config("vfd", "VFD", "VFD", nil, nil),
		config("sm", "SM", "SERVO_MOTOR", nil, map[string]string{"drive": "vfd"}),
	}, Options{})
	expectRule(t, err, "drive")
	_, err = NewSimulation("f", []Config{
		config("sd", "SD", "SERVO_DRIVE", nil, nil),
		config("m", "M", "MOTOR", nil, map[string]string{"drive": "sd"}),
	}, Options{})
	expectRule(t, err, "drive")
}

func TestEncoderCountsAMotorShaftAndLosesItsSignal(t *testing.T) {
	s := simulate(t,
		config("k", "K", "RELAY", map[string]any{"kind": "SOLID_STATE"}, nil),
		config("m", "M", "MOTOR", map[string]any{"ratedSpeedRpm": 600, "timeConstantS": 0.01}, map[string]string{"drive": "k"}),
		config("inc", "INC", "ENCODER", map[string]any{"pulsesPerRevolution": 60}, map[string]string{"measures": "m"}),
		config("abs", "ABS", "ENCODER", map[string]any{"kind": "ABSOLUTE", "pulsesPerRevolution": 60}, map[string]string{"measures": "m"}),
	)
	inputs(t, s, "k", Values{"coil": 1})
	run(t, s, 2)
	// 600 rpm = 10 rev/s: about 20 revolutions, 1200 pulses; the absolute one wraps each revolution.
	inc, abs := outputs(t, s, "inc"), outputs(t, s, "abs")
	near(t, inc["speed"], 600, 1e-6, "speed")
	near(t, inc["count"], 1200, 70, "incremental count")
	if abs["count"] < 0 || abs["count"] >= 60 {
		t.Fatalf("absolute count %g", abs["count"])
	}
	if _, err := s.InjectFault("inc", "SIGNAL_LOSS"); err != nil {
		t.Fatal(err)
	}
	run(t, s, 1)
	after := outputs(t, s, "inc")
	if after["count"] != inc["count"] || after["speed"] != 0 || s.devices["inc"].quality() != "BAD" || s.devices["inc"].Snapshot().Outputs["count"] != inc["count"] {
		t.Fatalf("signal loss: %v quality %s", after, s.devices["inc"].quality())
	}
	_, err := NewSimulation("f", []Config{
		config("v", "V", "VALVE", nil, nil),
		config("e", "E", "ENCODER", nil, map[string]string{"measures": "v"}),
	}, Options{})
	expectRule(t, err, "measured-signal")
	_, err = NewSimulation("f", []Config{config("e", "E", "ENCODER", nil, nil)}, Options{})
	expectRule(t, err, "measured-device")
}

// Controllers and the signal path (PR B).

func TestControllerClosesALoopOnAHeater(t *testing.T) {
	heater := map[string]any{"ambientC": 20, "riseAtFullPowerC": 100, "timeConstantS": 5, "maxTemperatureC": 500}
	controller := map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "value"}, "kp": 5, "ki": 0.5, "setpoint": 60, "deadband": 1}
	s := simulate(t,
		config("tt", "TT", "SENSOR", map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "temperature"}}, map[string]string{"measures": "h"}),
		config("tic", "TIC", "PID_CONTROLLER", controller, map[string]string{"measures": "tt"}),
		config("h", "H", "HEATER", heater, map[string]string{"controller": "tic"}),
	)
	if s.devices["tic"].state != "OFF" || outputs(t, s, "h")["heating"] != 0 {
		t.Fatalf("off: %s %v", s.devices["tic"].state, outputs(t, s, "h"))
	}
	// The PLC's on command is ignored while a controller is linked.
	inputs(t, s, "h", Values{"on": 1})
	run(t, s, 1)
	if outputs(t, s, "h")["heating"] != 0 {
		t.Fatalf("heater ignored its controller: %v", outputs(t, s, "h"))
	}
	inputs(t, s, "tic", Values{"enable": 1})
	run(t, s, tick)
	out := outputs(t, s, "tic")
	if s.devices["tic"].state != "AUTO" || out["output"] != 100 || outputs(t, s, "h")["heating"] != 1 {
		t.Fatalf("full output far from the setpoint: %v %v", out, outputs(t, s, "h"))
	}
	run(t, s, 60)
	out = outputs(t, s, "tic")
	near(t, out["processValue"], 60, 1.5, "settled at the setpoint")
	if out["atSetpoint"] != 1 {
		t.Fatalf("not at setpoint: %v", out)
	}
	near(t, outputs(t, s, "h")["temperature"], 60, 1.5, "the heater holds the setpoint")
	// A remote setpoint from the PLC takes over; direct action and alarms.
	inputs(t, s, "tic", Values{"enable": 1, "setpoint": 80})
	run(t, s, 60)
	near(t, outputs(t, s, "tic")["processValue"], 80, 1.5, "remote setpoint")
	// Manual passes the manual output through.
	inputs(t, s, "tic", Values{"enable": 1, "manual": 1, "manualOutput": 25})
	run(t, s, tick)
	if out := outputs(t, s, "tic"); out["output"] != 25 || s.devices["tic"].state != "MANUAL" {
		t.Fatalf("manual: %v %s", out, s.devices["tic"].state)
	}
	near(t, outputs(t, s, "h")["powerOutput"], 5*0.25, 1e-9, "a quarter of rated power")
	// An input failure drops the output to its minimum and is reported.
	if _, err := s.InjectFault("tic", "INPUT_FAILURE"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if out := outputs(t, s, "tic"); out["output"] != 0 || out["faulted"] != 1 || s.devices["tic"].state != "FAULTED" {
		t.Fatalf("input failure: %v", out)
	}
	_, err := NewSimulation("f", []Config{config("tic", "TIC", "PID_CONTROLLER", nil, nil)}, Options{})
	expectRule(t, err, "measured-device")
	_, err = NewSimulation("f", []Config{
		config("v", "V", "VALVE", nil, nil),
		config("h", "H", "HEATER", nil, map[string]string{"controller": "v"}),
	}, Options{})
	expectRule(t, err, "controller")
}

func TestControllerPositionsAValveWithDirectAction(t *testing.T) {
	// A level controller: the more level above the setpoint, the more the drain valve opens.
	s := simulate(t,
		config("lt", "LT", "SENSOR", map[string]any{"source": map[string]any{"kind": "CONSTANT", "value": 70}}, nil),
		config("lic", "LIC", "PID_CONTROLLER", map[string]any{"kp": 2, "ki": 0, "setpoint": 50, "action": "DIRECT", "alarmHigh": 65.0}, map[string]string{"measures": "lt"}),
		config("xv", "XV", "VALVE", map[string]any{"travelTimeS": 1}, map[string]string{"controller": "lic"}),
	)
	inputs(t, s, "lic", Values{"enable": 1})
	run(t, s, 2)
	out := outputs(t, s, "lic")
	near(t, out["output"], 40, 1e-9, "2 × (70 − 50) with direct action")
	if out["alarmHigh"] != 1 || out["alarmLow"] != 0 {
		t.Fatalf("alarms: %v", out)
	}
	near(t, outputs(t, s, "xv")["position"], 40, 1e-6, "the valve went to the controller's output")
	// Disabled, the valve follows the PLC again (no command: closes).
	inputs(t, s, "lic", Values{"enable": 0})
	run(t, s, 2)
	if outputs(t, s, "xv")["closed"] != 1 {
		t.Fatalf("valve did not return to the PLC's command: %v", outputs(t, s, "xv"))
	}
}

func TestSignalConditionerScalesAndReportsAnOpenInput(t *testing.T) {
	s := simulate(t,
		config("pt", "PT", "SENSOR", map[string]any{"source": map[string]any{"kind": "CONSTANT", "value": 6}}, nil),
		config("iso", "ISO", "SIGNAL_CONDITIONER", map[string]any{"inputMin": 4, "inputMax": 20, "outputMin": 0, "outputMax": 10}, map[string]string{"measures": "pt"}),
	)
	run(t, s, tick)
	near(t, outputs(t, s, "iso")["value"], 1.25, 1e-9, "4–20 mA onto 0–10 V")
	if s.devices["iso"].quality() != "GOOD" {
		t.Fatalf("quality %s", s.devices["iso"].quality())
	}
	if _, err := s.Force("pt", f64(30)); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	near(t, outputs(t, s, "iso")["value"], 10, 1e-9, "clamped at the output maximum")
	if _, err := s.InjectFault("iso", "OPEN_INPUT"); err != nil {
		t.Fatal(err)
	}
	run(t, s, tick)
	if out := outputs(t, s, "iso"); out["value"] != 0 || out["faulted"] != 1 || s.devices["iso"].quality() != "BAD" {
		t.Fatalf("open input: %v %s", out, s.devices["iso"].quality())
	}
	_, err := NewSimulation("f", []Config{
		config("sw", "SW", "SWITCH", nil, nil),
		config("iso", "ISO", "SIGNAL_CONDITIONER", map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "state"}}, map[string]string{"measures": "sw"}),
	}, Options{})
	expectRule(t, err, "measured-signal")
}

func TestActuatorStrokesSpringsBackAndLosesAir(t *testing.T) {
	s := simulate(t,
		config("cyl", "CYL", "ACTUATOR", map[string]any{"extendTimeS": 1, "retractTimeS": 2}, nil),
		config("spring", "SPRING", "ACTUATOR", map[string]any{"kind": "SINGLE_ACTING", "extendTimeS": 1, "retractTimeS": 1}, nil),
	)
	if out := outputs(t, s, "cyl"); out["retracted"] != 1 || s.devices["cyl"].state != "RETRACTED" {
		t.Fatalf("at rest: %v", out)
	}
	inputs(t, s, "cyl", Values{"extend": 1})
	inputs(t, s, "spring", Values{"extend": 1})
	run(t, s, 0.5)
	if out := outputs(t, s, "cyl"); out["moving"] != 1 || s.devices["cyl"].state != "EXTENDING" || out["retracted"] != 0 {
		t.Fatalf("extending: %v %s", out, s.devices["cyl"].state)
	}
	run(t, s, 0.6)
	if out := outputs(t, s, "cyl"); out["extended"] != 1 || s.devices["cyl"].state != "EXTENDED" {
		t.Fatalf("extended: %v %s", out, s.devices["cyl"].state)
	}
	// Double-acting holds with no command; single-acting springs back.
	inputs(t, s, "cyl", Values{})
	inputs(t, s, "spring", Values{})
	run(t, s, 1.1)
	if outputs(t, s, "cyl")["extended"] != 1 || outputs(t, s, "spring")["retracted"] != 1 {
		t.Fatalf("hold vs spring: %v %v", outputs(t, s, "cyl"), outputs(t, s, "spring"))
	}
	inputs(t, s, "cyl", Values{"retract": 1})
	run(t, s, 1)
	near(t, outputs(t, s, "cyl")["position"], 50, 1e-6, "halfway back at the retract time")
	if s.devices["cyl"].state != "RETRACTING" {
		t.Fatalf("state %s", s.devices["cyl"].state)
	}
	// Air loss stops the double-acting cylinder where it is, and springs the single-acting one back.
	if _, err := s.InjectFault("cyl", "AIR_LOSS"); err != nil {
		t.Fatal(err)
	}
	run(t, s, 1)
	if out := outputs(t, s, "cyl"); out["position"] != 50 || s.devices["cyl"].state != "STOPPED" || out["moving"] != 0 {
		t.Fatalf("air loss: %v %s", out, s.devices["cyl"].state)
	}
	inputs(t, s, "spring", Values{"extend": 1})
	if _, err := s.InjectFault("spring", "AIR_LOSS"); err != nil {
		t.Fatal(err)
	}
	run(t, s, 1.1)
	if outputs(t, s, "spring")["retracted"] != 1 {
		t.Fatalf("spring return on air loss: %v", outputs(t, s, "spring"))
	}
	// Stuck: nothing moves, nothing reported.
	if _, err := s.ClearFault("cyl", "AIR_LOSS"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InjectFault("cyl", "STUCK"); err != nil {
		t.Fatal(err)
	}
	run(t, s, 1)
	if outputs(t, s, "cyl")["position"] != 50 || s.devices["cyl"].Snapshot().Faulted != true {
		t.Fatalf("stuck: %v", outputs(t, s, "cyl"))
	}
}
