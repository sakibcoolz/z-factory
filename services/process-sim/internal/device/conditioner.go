package device

import "encoding/json"

// SignalConditioner is an isolator or converter in a signal path: it reads one output
// signal of the device it is linked to (link "measures") and maps its input range onto
// its output range, clamped. An open input reads the bottom of the output range with bad
// quality and is reported. Approximation: linear scaling without lag, noise or isolation
// errors.
type SignalConditioner struct {
	params  conditionerParams
	value   float64
	quality string
}

type conditionerParams struct {
	Source    measuredSource `json:"source"`
	InputMin  float64        `json:"inputMin"`
	InputMax  float64        `json:"inputMax"`
	OutputMin float64        `json:"outputMin"`
	OutputMax float64        `json:"outputMax"`
}

func defaultConditionerParams() conditionerParams {
	return conditionerParams{Source: measuredSource{Kind: "MEASURED", Signal: "value"}, InputMin: 0, InputMax: 100, OutputMin: 0, OutputMax: 100}
}

func init() {
	Register("SIGNAL_CONDITIONER", func() Behavior { return &SignalConditioner{} }, func() Description {
		return Description{
			Key:     "SIGNAL_CONDITIONER",
			Version: 1,
			Summary: "A signal conditioner or isolator: maps one output signal of the device it is linked to from its input range onto its output range, clamped; an open input reads the bottom of the output range with bad quality.",
			Signals: []Signal{
				{Key: "value", Direction: Out, Kind: Number, Label: "Conditioned value"},
				faulted,
			},
			Faults: []Fault{
				{Code: "OPEN_INPUT", Name: "Open input", Severity: Warning, Latching: false},
			},
			Links:      []Link{{Role: "measures", Meaning: "the device whose output signal is conditioned; required"}},
			Parameters: mustJSON(defaultConditionerParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "source", Label: "Input signal", Kind: "STRUCTURED", Role: "SOURCE", Default: map[string]any{"kind": "MEASURED", "signal": "value"}, Kinds: measuredKinds, Description: "The output signal of the measured device, scaled by gain and offset before the range mapping."},
				{Key: "inputMin", Label: "Input range minimum", Kind: "NUMBER", Role: "LIMIT", Default: 0.0},
				{Key: "inputMax", Label: "Input range maximum", Kind: "NUMBER", Role: "LIMIT", Default: 100.0, Description: "Above the input range minimum."},
				{Key: "outputMin", Label: "Output range minimum", Kind: "NUMBER", Role: "LIMIT", Default: 0.0},
				{Key: "outputMax", Label: "Output range maximum", Kind: "NUMBER", Role: "LIMIT", Default: 100.0, Description: "Above the output range minimum."},
			},
			States: []string{"GOOD", "BAD"},
		}
	})
}

func (s *SignalConditioner) Profile() string { return "SIGNAL_CONDITIONER" }
func (s *SignalConditioner) Version() int    { return 1 }

func (s *SignalConditioner) Configure(raw json.RawMessage) error {
	params := defaultConditionerParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := params.Source.check(); err != nil {
		return err
	}
	for name, value := range map[string]float64{"inputMin": params.InputMin, "inputMax": params.InputMax, "outputMin": params.OutputMin, "outputMax": params.OutputMax} {
		if !finite(value) {
			return &ParamError{Name: name, Reason: "must be a finite number"}
		}
	}
	if params.InputMax <= params.InputMin {
		return &ParamError{Name: "inputMax", Reason: "must be above inputMin"}
	}
	if params.OutputMax <= params.OutputMin {
		return &ParamError{Name: "outputMax", Reason: "must be above outputMin"}
	}
	s.params = params
	s.value, s.quality = params.OutputMin, "GOOD"
	return nil
}

// Observes marks the conditioner as an observer: stepped after the device it reads.
func (s *SignalConditioner) Observes() {}

func (s *SignalConditioner) Step(_ float64, ctx *Context) {
	p := s.params
	if ctx.ActiveFaults["OPEN_INPUT"] {
		s.value, s.quality = p.OutputMin, "BAD"
		return
	}
	in := clamp(p.Source.read(ctx), p.InputMin, p.InputMax)
	s.value = p.OutputMin + (in-p.InputMin)/(p.InputMax-p.InputMin)*(p.OutputMax-p.OutputMin)
	s.quality = "GOOD"
}

func (s *SignalConditioner) Outputs(ctx *Context) Values {
	return Values{"value": s.value, "faulted": asFloat(reportsFault(ctx))}
}

func (s *SignalConditioner) State() string { return s.quality }

func (s *SignalConditioner) Internal() map[string]float64 {
	return map[string]float64{"value": s.value}
}

// Quality of the value: BAD while the input is open.
func (s *SignalConditioner) Quality() string { return s.quality }
