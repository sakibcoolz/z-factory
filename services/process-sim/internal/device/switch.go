package device

import "encoding/json"

// Switch is a contact the PLC reads: held at a constant state, operated by hand (forced),
// or closing above and opening below thresholds on an output signal of the device it
// measures (link "measures"), with hysteresis. Stuck, it keeps its state.
type Switch struct {
	params switchParams
	on     bool
	state  string
}

type switchSource struct {
	Kind string `json:"kind"`
	// CONSTANT
	State bool `json:"state"`
	// MEASURED: closes at or above OnAbove, opens at or below OffBelow (defaults to OnAbove).
	Signal   string   `json:"signal"`
	OnAbove  float64  `json:"onAbove"`
	OffBelow *float64 `json:"offBelow"`
}

type switchParams struct {
	Source switchSource `json:"source"`
}

func init() {
	Register("SWITCH", func() Behavior { return &Switch{} }, func() Description {
		return Description{
			Key:     "SWITCH",
			Version: 1,
			Summary: "A contact held at a constant state, operated by hand, or switching on a measured signal with hysteresis; stuck, it keeps its state.",
			Signals: []Signal{{Key: "state", Direction: Out, Kind: Bool, Label: "Switch state"}},
			Faults:  []Fault{stuck},
			Links:   []Link{{Role: "measures", Meaning: "the device whose numeric output signal a MEASURED source switches on"}},
			Parameters: mustJSON(map[string]any{
				"source": map[string]any{"kind": "CONSTANT", "state": false},
				"sourceKinds": map[string]any{
					"CONSTANT": []string{"state"},
					"MEASURED": []string{"signal", "onAbove", "offBelow"},
				},
			}),
			States:     []string{"OFF", "ON"},
			Forcible:   true,
			ForcedKind: Bool,
		}
	})
}

func (s *Switch) Profile() string { return "SWITCH" }
func (s *Switch) Version() int    { return 1 }

func (s *Switch) Configure(raw json.RawMessage) error {
	params := switchParams{Source: switchSource{Kind: "CONSTANT"}}
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	switch params.Source.Kind {
	case "CONSTANT":
	case "MEASURED":
		if params.Source.Signal == "" || len(params.Source.Signal) > 64 {
			return &ParamError{Name: "source.signal", Reason: "must name an output signal of the measured device"}
		}
		if !finite(params.Source.OnAbove) || (params.Source.OffBelow != nil && !finite(*params.Source.OffBelow)) {
			return &ParamError{Name: "source.onAbove", Reason: "and source.offBelow must be finite numbers"}
		}
	default:
		return &ParamError{Name: "source.kind", Reason: "must be CONSTANT or MEASURED"}
	}
	s.params = params
	s.on = false
	s.state = "OFF"
	return nil
}

func (s *Switch) Step(_ float64, ctx *Context) {
	if !ctx.Tripped && !ctx.ActiveFaults["STUCK"] {
		source := s.params.Source
		switch {
		case ctx.Forced != nil:
			s.on = *ctx.Forced > 0.5
		case source.Kind == "CONSTANT":
			s.on = source.State
		default:
			value := 0.0
			if peer := ctx.Peer("measures"); peer != nil {
				value = peer.outputs[source.Signal]
			}
			offBelow := source.OnAbove
			if source.OffBelow != nil {
				offBelow = *source.OffBelow
			}
			if value >= source.OnAbove {
				s.on = true
			} else if value <= offBelow {
				s.on = false
			}
		}
	}
	if s.on {
		s.state = "ON"
	} else {
		s.state = "OFF"
	}
}

func (s *Switch) Outputs(_ *Context) Values { return Values{"state": asFloat(s.on)} }

func (s *Switch) State() string { return s.state }

func (s *Switch) Internal() map[string]float64 { return map[string]float64{"on": asFloat(s.on)} }

func (s *Switch) ForcedKind() Kind { return Bool }
