package device

import "encoding/json"

// Actuator is a pneumatic cylinder: the extend and retract commands (solenoid valves)
// move the rod over its stroke at the extend and retract times, and the end sensors
// report the ends. A single-acting cylinder returns by spring when extend drops; a
// double-acting one holds where it is with neither (or both) commands. Lost air stops a
// double-acting cylinder where it is and lets a single-acting one spring back. Stuck, it
// does not move. Neither is reported: the PLC sees it through the end sensors.
// Approximation: constant rod speed; no cushioning, pressure, load or leakage.
type Actuator struct {
	params   actuatorParams
	position float64 // 0 retracted … 100 extended
	state    string
}

type actuatorParams struct {
	// DOUBLE_ACTING holds with no command; SINGLE_ACTING springs back when extend drops.
	Kind string `json:"kind"`
	// Time for the full stroke out.
	ExtendTimeS float64 `json:"extendTimeS"`
	// Time for the full stroke back.
	RetractTimeS    float64 `json:"retractTimeS"`
	InitialPosition float64 `json:"initialPosition"`
}

func defaultActuatorParams() actuatorParams {
	return actuatorParams{Kind: "DOUBLE_ACTING", ExtendTimeS: 1, RetractTimeS: 1, InitialPosition: 0}
}

func init() {
	Register("ACTUATOR", func() Behavior { return &Actuator{} }, func() Description {
		return Description{
			Key:     "ACTUATOR",
			Version: 1,
			Summary: "A pneumatic cylinder: the extend and retract commands move the rod over its stroke at the extend and retract times and the end sensors report the ends; single-acting springs back when extend drops, double-acting holds with no command; lost air stops it (or springs it back) and stuck it does not move, neither reported.",
			Signals: []Signal{
				{Key: "extend", Direction: In, Kind: Bool, Label: "Extend command"},
				{Key: "retract", Direction: In, Kind: Bool, Label: "Retract command (double-acting)"},
				{Key: "extended", Direction: Out, Kind: Bool, Label: "Extended end sensor"},
				{Key: "retracted", Direction: Out, Kind: Bool, Label: "Retracted end sensor"},
				{Key: "moving", Direction: Out, Kind: Bool, Label: "Moving"},
				{Key: "position", Direction: Out, Kind: Number, Label: "Rod position", Unit: "%"},
			},
			Faults: []Fault{
				{Code: "STUCK", Name: "Stuck", Severity: Warning, Latching: false, Silent: true},
				{Code: "AIR_LOSS", Name: "Air supply lost", Severity: Critical, Latching: false, Silent: true},
			},
			Parameters: mustJSON(defaultActuatorParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "kind", Label: "Kind", Kind: "CHOICE", Role: "SHAPE", Default: "DOUBLE_ACTING", Choices: []string{"DOUBLE_ACTING", "SINGLE_ACTING"}, Description: "Double-acting holds with no command; single-acting springs back when extend drops."},
				secondsParam("extendTimeS", "Extend time", 1, "Time for the full stroke out."),
				secondsParam("retractTimeS", "Retract time", 1, "Time for the full stroke back."),
				{Key: "initialPosition", Label: "Initial position", Kind: "NUMBER", Role: "INITIAL", Unit: "%", Default: 0.0, Min: f64(0), Max: f64(100), MinInclusive: true, MaxInclusive: true},
			},
			States: []string{"RETRACTED", "EXTENDING", "EXTENDED", "RETRACTING", "STOPPED"},
		}
	})
}

func (a *Actuator) Profile() string { return "ACTUATOR" }
func (a *Actuator) Version() int    { return 1 }

func (a *Actuator) Configure(raw json.RawMessage) error {
	params := defaultActuatorParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	switch params.Kind {
	case "DOUBLE_ACTING", "SINGLE_ACTING":
	default:
		return &ParamError{Name: "kind", Reason: `must be "DOUBLE_ACTING" or "SINGLE_ACTING"`}
	}
	for name, value := range map[string]float64{"extendTimeS": params.ExtendTimeS, "retractTimeS": params.RetractTimeS} {
		if err := seconds(name, value); err != nil {
			return err
		}
	}
	if err := within("initialPosition", params.InitialPosition, 0, 100); err != nil {
		return err
	}
	a.params = params
	a.position = params.InitialPosition
	a.state = a.restState()
	return nil
}

func (a *Actuator) restState() string {
	switch {
	case a.position >= 99.5:
		return "EXTENDED"
	case a.position <= 0.5:
		return "RETRACTED"
	default:
		return "STOPPED"
	}
}

func (a *Actuator) Step(dt float64, ctx *Context) {
	p := a.params
	airLost := ctx.ActiveFaults["AIR_LOSS"]
	extend, retract := ctx.Inputs.On("extend"), ctx.Inputs.On("retract")
	target := a.position
	switch {
	case p.Kind == "SINGLE_ACTING":
		// The spring returns it whenever the extend pressure is gone.
		if extend && !airLost {
			target = 100
		} else {
			target = 0
		}
	case airLost:
		target = a.position
	case extend && !retract:
		target = 100
	case retract && !extend:
		target = 0
	}
	if ctx.ActiveFaults["STUCK"] {
		target = a.position
	}
	speed := 100 / p.ExtendTimeS
	if target < a.position {
		speed = 100 / p.RetractTimeS
	}
	before := a.position
	a.position = approach(a.position, target, speed*dt)
	switch {
	case a.position > before:
		a.state = "EXTENDING"
	case a.position < before:
		a.state = "RETRACTING"
	default:
		a.state = a.restState()
	}
}

func (a *Actuator) Outputs(_ *Context) Values {
	return Values{
		"extended":  asFloat(a.position >= 99.5),
		"retracted": asFloat(a.position <= 0.5),
		"moving":    asFloat(a.state == "EXTENDING" || a.state == "RETRACTING"),
		"position":  a.position,
	}
}

func (a *Actuator) State() string { return a.state }

func (a *Actuator) Internal() map[string]float64 { return map[string]float64{"position": a.position} }
