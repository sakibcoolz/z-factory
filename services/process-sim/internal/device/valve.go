package device

import "encoding/json"

// Valve is an on/off or modulating valve: it travels linearly at its stroke time towards
// what the commands ask (an analog position setpoint; or open and close commands, double-
// acting when a close command is wired and single-acting otherwise) and reports its
// position and limit switches. Stuck, it does not move and does not say so.
type Valve struct {
	params   valveParams
	position float64 // 0 closed … 100 open
	state    string
}

type valveParams struct {
	// Time for a full stroke.
	TravelTimeS     float64 `json:"travelTimeS"`
	InitialPosition float64 `json:"initialPosition"`
}

func defaultValveParams() valveParams { return valveParams{TravelTimeS: 5, InitialPosition: 0} }

func init() {
	Register("VALVE", func() Behavior { return &Valve{} }, func() Description {
		return Description{
			Key:     "VALVE",
			Version: 1,
			Summary: "A valve that travels at its stroke time to the commanded position (open/close commands, or an analog setpoint) and reports its position and limit switches; stuck, it stays where it is.",
			Signals: []Signal{
				{Key: "open", Direction: In, Kind: Bool, Label: "Open command"},
				{Key: "close", Direction: In, Kind: Bool, Label: "Close command"},
				{Key: "positionSetpoint", Direction: In, Kind: Number, Label: "Position setpoint", Unit: "%"},
				faultReset,
				{Key: "position", Direction: Out, Kind: Number, Label: "Actual position", Unit: "%"},
				{Key: "opened", Direction: Out, Kind: Bool, Label: "Open limit switch"},
				{Key: "closed", Direction: Out, Kind: Bool, Label: "Closed limit switch"},
				faulted,
			},
			Faults: []Fault{stuck, limitSwitchFault},
			Links: []Link{
				{Role: "controller", Accepts: []string{"PID_CONTROLLER"}, Meaning: "the controller whose output is the position setpoint while it is enabled; the PLC's commands apply otherwise"},
			},
			Parameters: mustJSON(defaultValveParams()),
			ParameterSchema: []ParameterSpec{
				secondsParam("travelTimeS", "Travel time", 5, "Time for a full stroke."),
				{Key: "initialPosition", Label: "Initial position", Kind: "NUMBER", Role: "INITIAL", Unit: "%", Default: 0.0, Min: f64(0), Max: f64(100), MinInclusive: true, MaxInclusive: true},
			},
			States: []string{"CLOSED", "OPENING", "OPEN", "CLOSING", "STOPPED", "FAULTED"},
		}
	})
}

var stuck = Fault{Code: "STUCK", Name: "Stuck", Severity: Warning, Latching: false, Silent: true}

// limitSwitchFault is a limit-switch disagreement: both end switches read closed at once,
// whatever the position; the valve cannot tell, the PLC's logic can (TASK-1014).
var limitSwitchFault = Fault{Code: "LIMIT_SWITCH_FAULT", Name: "Limit switch disagreement", Severity: Warning, Latching: false, Silent: true}

func (v *Valve) Profile() string { return "VALVE" }
func (v *Valve) Version() int    { return 1 }

func (v *Valve) Configure(raw json.RawMessage) error {
	params := defaultValveParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := seconds("travelTimeS", params.TravelTimeS); err != nil {
		return err
	}
	if err := within("initialPosition", params.InitialPosition, 0, 100); err != nil {
		return err
	}
	v.params = params
	v.position = params.InitialPosition
	v.state = stateOfPosition(v.position)
	return nil
}

func stateOfPosition(position float64) string {
	switch {
	case position >= 99.5:
		return "OPEN"
	case position <= 0.5:
		return "CLOSED"
	default:
		return "STOPPED"
	}
}

func (v *Valve) Step(dt float64, ctx *Context) {
	inputs := ctx.Inputs
	target := v.position
	controller, controlled := peerBehavior[*Controller](ctx, "controller")
	switch {
	case controlled && controller.enabled:
		target = clamp(controller.share()*100, 0, 100)
	case inputs.Has("positionSetpoint"):
		target = clamp(inputs["positionSetpoint"], 0, 100)
	case inputs.Has("close"):
		// Double-acting: holds its position when neither (or both) commands are present.
		if inputs.On("open") && !inputs.On("close") {
			target = 100
		} else if inputs.On("close") && !inputs.On("open") {
			target = 0
		}
	case inputs.On("open"):
		target = 100
	default:
		target = 0
	}
	frozen := ctx.Tripped || ctx.ActiveFaults["STUCK"]
	if !frozen {
		v.position = approach(v.position, target, 100/v.params.TravelTimeS*dt)
	}
	switch {
	case ctx.Tripped:
		v.state = "FAULTED"
	case !frozen && v.position != target && target > v.position:
		v.state = "OPENING"
	case !frozen && v.position != target:
		v.state = "CLOSING"
	default:
		v.state = stateOfPosition(v.position)
	}
}

func (v *Valve) Outputs(ctx *Context) Values {
	disagree := ctx.ActiveFaults["LIMIT_SWITCH_FAULT"]
	return Values{
		"position": v.position,
		"opened":   asFloat(disagree || v.position >= 99.5),
		"closed":   asFloat(disagree || v.position <= 0.5),
		"faulted":  asFloat(reportsFault(ctx)),
	}
}

func (v *Valve) State() string { return v.state }

func (v *Valve) Internal() map[string]float64 { return map[string]float64{"position": v.position} }
