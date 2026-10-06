package sim

import "math"

// PumpHouse is the process model of the shipped PUMP_HOUSE module type (docs/process-modules.md):
// a duty pump whose speed follows the PLC's run command and speed setpoint with a ramp, delivering
// into a discharge line with an optional discharge valve. Pressure follows the affinity law.
//
// Inputs (what the PLC drives): DUTY_RUN_CMD (0/1), DUTY_SPEED_SETPOINT (%; 100 when the
// PLC gives none), DISCHARGE_VALVE_CMD (0/1; open when the PLC gives none).
// Outputs (what the PLC reads): DUTY_RUNNING, DUTY_SPEED (%), FLOW (m3/h), DISCHARGE_PRESSURE
// (bar), DISCHARGE_VALVE_OPEN, LOW_PRESSURE (alarm).
type PumpHouse struct {
	params   map[string]float64
	speed    float64 // % of rated speed
	valve    float64 // 0 closed … 1 open
	running  bool
	lowAlarm bool
}

func init() { Register("PUMP_HOUSE", func() Model { return &PumpHouse{} }) }

func (m *PumpHouse) Type() string { return "PUMP_HOUSE" }
func (m *PumpHouse) Version() int { return 1 }
func (m *PumpHouse) Inputs() []string {
	return []string{"DUTY_RUN_CMD", "DUTY_SPEED_SETPOINT", "DISCHARGE_VALVE_CMD"}
}
func (m *PumpHouse) Outputs() []string {
	return []string{"DUTY_RUNNING", "DUTY_SPEED", "FLOW", "DISCHARGE_PRESSURE", "DISCHARGE_VALVE_OPEN", "LOW_PRESSURE"}
}

// Parameters: rated flow at full speed, rated discharge pressure at full speed, the time
// to ramp from zero to full speed, the valve's travel time, the pressure below which a
// pump running at half speed or more raises the low-pressure alarm (a share of the rated
// pressure), and whether the discharge valve starts open.
func (m *PumpHouse) Parameters() map[string]float64 {
	return map[string]float64{
		"ratedFlow":        50,
		"ratedPressure":    6,
		"rampTimeS":        5,
		"valveTravelS":     5,
		"lowPressureRatio": 0.3,
		"initialValveOpen": 1,
	}
}

func (m *PumpHouse) Reset(given map[string]float64) error {
	params, err := resolve(m.Parameters(), given, "ratedFlow", "ratedPressure", "rampTimeS", "valveTravelS")
	if err != nil {
		return err
	}
	if params["lowPressureRatio"] < 0 || params["lowPressureRatio"] > 1 {
		return &ParamError{Name: "lowPressureRatio", Reason: "must be between 0 and 1"}
	}
	m.params = params
	m.speed = 0
	m.valve = clamp(params["initialValveOpen"], 0, 1)
	m.running = false
	m.lowAlarm = false
	return nil
}

func (m *PumpHouse) Step(dt float64, inputs map[string]float64) (map[string]float64, []Event) {
	var events []Event
	run := boolean(inputs, "DUTY_RUN_CMD")
	setpoint := 100.0
	if value, given := inputs["DUTY_SPEED_SETPOINT"]; given {
		setpoint = clamp(value, 0, 100)
	}
	valveCommand := 1.0
	if value, given := inputs["DISCHARGE_VALVE_CMD"]; given {
		valveCommand = asFloat(value > 0.5)
	}

	target := 0.0
	if run {
		target = setpoint
	}
	m.speed = towards(m.speed, target, 100/m.params["rampTimeS"], dt)
	m.valve = towards(m.valve, valveCommand, 1/m.params["valveTravelS"], dt)

	wasRunning := m.running
	m.running = m.speed > 0
	if m.running && !wasRunning {
		events = append(events, Event{Type: "PUMP_STARTED", Message: "duty pump started"})
	}
	if !m.running && wasRunning {
		events = append(events, Event{Type: "PUMP_STOPPED", Message: "duty pump stopped"})
	}

	ratio := m.speed / 100
	flow := m.params["ratedFlow"] * ratio * m.valve
	pressure := m.params["ratedPressure"] * ratio * ratio
	// Low pressure: the pump has reached a setpoint of at least half speed and still delivers
	// less than the limit. A pump asked for a low speed is not in alarm for being slow.
	low := run && setpoint >= 50 && m.speed >= setpoint && pressure < m.params["lowPressureRatio"]*m.params["ratedPressure"]
	if low && !m.lowAlarm {
		events = append(events, Event{Type: "ALARM_RAISED", Message: "discharge pressure low", Values: map[string]float64{"pressure": pressure}})
	}
	if !low && m.lowAlarm {
		events = append(events, Event{Type: "ALARM_CLEARED", Message: "discharge pressure low cleared"})
	}
	m.lowAlarm = low

	return map[string]float64{
		"DUTY_RUNNING":         asFloat(m.running),
		"DUTY_SPEED":           round(m.speed),
		"FLOW":                 round(flow),
		"DISCHARGE_PRESSURE":   round(pressure),
		"DISCHARGE_VALVE_OPEN": asFloat(m.valve >= 0.999),
		"LOW_PRESSURE":         asFloat(low),
	}, events
}

func (m *PumpHouse) State() map[string]float64 {
	return map[string]float64{"speed": m.speed, "valve": m.valve, "running": asFloat(m.running), "lowAlarm": asFloat(m.lowAlarm)}
}

// round keeps outputs to a fixed precision, so equal states give byte-equal snapshots.
func round(value float64) float64 { return math.Round(value*1e6) / 1e6 }
