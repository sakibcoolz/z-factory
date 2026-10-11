package device

import "encoding/json"

// Relay is a relay, contactor or solid-state relay: a coil (or control input) the PLC
// drives, main contacts that close after a pickup delay and open after a dropout delay,
// and a normally-open and a normally-closed auxiliary contact that follow the main
// contacts. A motor or a heater fed by it (their "drive" and "contactor" links) is
// energized while the contacts are closed. Approximation: one delay each way; no
// contact bounce, arc, wear or coil inrush. It reports nothing of its own: a welded or an
// open coil is seen only through what it switches.
type Relay struct {
	params relayParams
	closed bool
	// Seconds the coil has been in its current state, for the delays.
	sinceS float64
	state  string
}

type relayParams struct {
	// ELECTROMECHANICAL (delays apply) or SOLID_STATE (switches at once).
	Kind string `json:"kind"`
	// Time from coil on to contacts closed.
	PickupTimeS float64 `json:"pickupTimeS"`
	// Time from coil off to contacts open.
	DropoutTimeS float64 `json:"dropoutTimeS"`
}

func defaultRelayParams() relayParams {
	return relayParams{Kind: "ELECTROMECHANICAL", PickupTimeS: 0.02, DropoutTimeS: 0.02}
}

func init() {
	Register("RELAY", func() Behavior { return &Relay{} }, func() Description {
		return Description{
			Key:     "RELAY",
			Version: 1,
			Summary: "A relay, contactor or solid-state relay: its contacts close a pickup time after the coil is energized and open a dropout time after it is released; auxiliary contacts follow; welded contacts stay closed and an open coil never closes them.",
			Signals: []Signal{
				{Key: "coil", Direction: In, Kind: Bool, Label: "Coil (control input)"},
				{Key: "closed", Direction: Out, Kind: Bool, Label: "Main contacts closed"},
				{Key: "auxNo", Direction: Out, Kind: Bool, Label: "Auxiliary contact, normally open"},
				{Key: "auxNc", Direction: Out, Kind: Bool, Label: "Auxiliary contact, normally closed"},
			},
			Faults: []Fault{
				{Code: "WELDED_CONTACTS", Name: "Welded contacts", Severity: Critical, Latching: false, Silent: true},
				{Code: "COIL_OPEN", Name: "Coil open circuit", Severity: Warning, Latching: false, Silent: true},
			},
			Parameters: mustJSON(defaultRelayParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "kind", Label: "Kind", Kind: "CHOICE", Role: "SHAPE", Default: "ELECTROMECHANICAL", Choices: []string{"ELECTROMECHANICAL", "SOLID_STATE"}, Description: "A solid-state relay switches without pickup or dropout delay."},
				{Key: "pickupTimeS", Label: "Pickup time", Kind: "NUMBER", Role: "TIMING", Unit: "s", Default: 0.02, Min: f64(0), Max: f64(10), MinInclusive: true, MaxInclusive: true, Description: "Time from coil on to contacts closed."},
				{Key: "dropoutTimeS", Label: "Dropout time", Kind: "NUMBER", Role: "TIMING", Unit: "s", Default: 0.02, Min: f64(0), Max: f64(10), MinInclusive: true, MaxInclusive: true, Description: "Time from coil off to contacts open."},
			},
			States: []string{"OPEN", "PICKING_UP", "CLOSED", "DROPPING_OUT"},
		}
	})
}

func (r *Relay) Profile() string { return "RELAY" }
func (r *Relay) Version() int    { return 1 }

func (r *Relay) Configure(raw json.RawMessage) error {
	params := defaultRelayParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	switch params.Kind {
	case "ELECTROMECHANICAL", "SOLID_STATE":
	default:
		return &ParamError{Name: "kind", Reason: `must be "ELECTROMECHANICAL" or "SOLID_STATE"`}
	}
	for name, value := range map[string]float64{"pickupTimeS": params.PickupTimeS, "dropoutTimeS": params.DropoutTimeS} {
		if err := within(name, value, 0, 10); err != nil {
			return err
		}
	}
	r.params = params
	r.closed, r.sinceS = false, 0
	r.state = "OPEN"
	return nil
}

// energized is what the coil asks for: on, unless the coil is open.
func (r *Relay) energized(ctx *Context) bool {
	return ctx.Inputs.On("coil") && !ctx.ActiveFaults["COIL_OPEN"]
}

func (r *Relay) Step(dt float64, ctx *Context) {
	want := r.energized(ctx)
	if want == r.closed {
		r.sinceS = 0
	} else {
		r.sinceS += dt
		delay := r.params.PickupTimeS
		if r.closed {
			delay = r.params.DropoutTimeS
		}
		if r.params.Kind == "SOLID_STATE" || r.sinceS >= delay {
			r.closed, r.sinceS = want, 0
		}
	}
	if ctx.ActiveFaults["WELDED_CONTACTS"] {
		r.closed, r.sinceS = true, 0
	}
	switch {
	case r.closed && !want && !ctx.ActiveFaults["WELDED_CONTACTS"]:
		r.state = "DROPPING_OUT"
	case r.closed:
		r.state = "CLOSED"
	case want:
		r.state = "PICKING_UP"
	default:
		r.state = "OPEN"
	}
}

func (r *Relay) Outputs(_ *Context) Values {
	return Values{"closed": asFloat(r.closed), "auxNo": asFloat(r.closed), "auxNc": asFloat(!r.closed)}
}

func (r *Relay) State() string { return r.state }

func (r *Relay) Internal() map[string]float64 {
	return map[string]float64{"closed": asFloat(r.closed), "sinceS": r.sinceS}
}

// Supply of a motor fed through the relay's contacts: line frequency while closed.
func (r *Relay) Supply(_ *Context) SupplyState {
	return SupplyState{Energized: r.closed, Line: true}
}

// Closed is what a heater fed through the relay sees.
func (r *Relay) Closed() bool { return r.closed }
