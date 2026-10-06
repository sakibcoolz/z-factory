package sim

// Tank is the process model of the shipped TANK module type: a vessel filled through an
// inlet valve and emptied through an outlet valve, each moving with a travel time, with
// level switches and alarms. Flow is constant while a valve is open (a gravity or pumped
// supply at a fixed rate), scaled by how far the valve has travelled.
//
// Inputs: INLET_VALVE_CMD (0/1), OUTLET_VALVE_CMD (0/1), AGITATOR_RUN_CMD (0/1).
// Outputs: LEVEL (%), CONTENT (m3), INLET_VALVE_OPEN, OUTLET_VALVE_OPEN, AGITATOR_RUNNING,
// HIGH_LEVEL (switch), LEVEL_HIGH (alarm), LEVEL_LOW (alarm).
type Tank struct {
	params  map[string]float64
	content float64 // m3
	inlet   float64 // 0 closed … 1 open
	outlet  float64
	high    bool
	low     bool
}

func init() { Register("TANK", func() Model { return &Tank{} }) }

func (m *Tank) Type() string { return "TANK" }
func (m *Tank) Version() int { return 1 }
func (m *Tank) Inputs() []string {
	return []string{"INLET_VALVE_CMD", "OUTLET_VALVE_CMD", "AGITATOR_RUN_CMD"}
}
func (m *Tank) Outputs() []string {
	return []string{"LEVEL", "CONTENT", "INLET_VALVE_OPEN", "OUTLET_VALVE_OPEN", "AGITATOR_RUNNING", "HIGH_LEVEL", "LEVEL_HIGH", "LEVEL_LOW"}
}

// Parameters: the vessel's volume, the inflow and outflow at a fully open valve (m3/h),
// the valves' travel time, the initial level (%), and the levels (%) of the high switch
// and of the two alarms.
func (m *Tank) Parameters() map[string]float64 {
	return map[string]float64{
		"volume":          10,
		"inflowRate":      20,
		"outflowRate":     15,
		"valveTravelS":    5,
		"initialLevel":    0,
		"highSwitchLevel": 90,
		"highAlarmLevel":  95,
		"lowAlarmLevel":   5,
	}
}

func (m *Tank) Reset(given map[string]float64) error {
	params, err := resolve(m.Parameters(), given, "volume", "inflowRate", "outflowRate", "valveTravelS")
	if err != nil {
		return err
	}
	for _, key := range []string{"initialLevel", "highSwitchLevel", "highAlarmLevel", "lowAlarmLevel"} {
		if params[key] < 0 || params[key] > 100 {
			return &ParamError{Name: key, Reason: "must be a level between 0 and 100 %"}
		}
	}
	m.params = params
	m.content = params["volume"] * params["initialLevel"] / 100
	m.inlet, m.outlet = 0, 0
	m.high, m.low = false, false
	return nil
}

func (m *Tank) Step(dt float64, inputs map[string]float64) (map[string]float64, []Event) {
	var events []Event
	rate := 1 / m.params["valveTravelS"]
	m.inlet = towards(m.inlet, asFloat(boolean(inputs, "INLET_VALVE_CMD")), rate, dt)
	m.outlet = towards(m.outlet, asFloat(boolean(inputs, "OUTLET_VALVE_CMD")), rate, dt)

	// Rates are per hour; a tick is seconds.
	inflow := m.params["inflowRate"] * m.inlet / 3600
	outflow := m.params["outflowRate"] * m.outlet / 3600
	if m.content <= 0 && outflow > inflow {
		outflow = inflow // an empty tank gives nothing
	}
	m.content = clamp(m.content+(inflow-outflow)*dt, 0, m.params["volume"])
	level := 100 * m.content / m.params["volume"]

	high := level >= m.params["highAlarmLevel"]
	low := level <= m.params["lowAlarmLevel"]
	if high && !m.high {
		events = append(events, Event{Type: "ALARM_RAISED", Message: "level high", Values: map[string]float64{"level": level}})
	}
	if !high && m.high {
		events = append(events, Event{Type: "ALARM_CLEARED", Message: "level high cleared"})
	}
	if low && !m.low {
		events = append(events, Event{Type: "ALARM_RAISED", Message: "level low", Values: map[string]float64{"level": level}})
	}
	if !low && m.low {
		events = append(events, Event{Type: "ALARM_CLEARED", Message: "level low cleared"})
	}
	m.high, m.low = high, low

	return map[string]float64{
		"LEVEL":             round(level),
		"CONTENT":           round(m.content),
		"INLET_VALVE_OPEN":  asFloat(m.inlet >= 0.999),
		"OUTLET_VALVE_OPEN": asFloat(m.outlet >= 0.999),
		"AGITATOR_RUNNING":  asFloat(boolean(inputs, "AGITATOR_RUN_CMD")),
		"HIGH_LEVEL":        asFloat(level >= m.params["highSwitchLevel"]),
		"LEVEL_HIGH":        asFloat(high),
		"LEVEL_LOW":         asFloat(low),
	}, events
}

func (m *Tank) State() map[string]float64 {
	return map[string]float64{"content": m.content, "inlet": m.inlet, "outlet": m.outlet, "high": asFloat(m.high), "low": asFloat(m.low)}
}
