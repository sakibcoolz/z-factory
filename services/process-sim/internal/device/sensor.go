package device

import (
	"encoding/json"
	"math"
)

// Sensor is a transmitter: it reports a value from a source (a constant, a ramp, a sine,
// seeded random samples, or an output signal of the device it measures, link "measures")
// through a first-order lag and within its range. A lost signal reads as the bottom of
// the range with bad quality; stuck, it freezes.
type Sensor struct {
	params      sensorParams
	value       float64
	quality     string
	random      mulberry32
	sample      float64
	nextSample  float64
	lastEmitted float64
	state       string
}

type sensorSource struct {
	Kind string `json:"kind"`
	// CONSTANT
	Value float64 `json:"value"`
	// RAMP: a sawtooth from From to To, repeating every PeriodS; SINE between Min and Max.
	From    float64 `json:"from"`
	To      float64 `json:"to"`
	PeriodS float64 `json:"periodS"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	// RANDOM: a new uniformly distributed sample every IntervalS from a seeded generator.
	IntervalS float64 `json:"intervalS"`
	Seed      *int64  `json:"seed"`
	// MEASURED: value = the measured device's signal × Gain + Offset.
	Signal string   `json:"signal"`
	Gain   *float64 `json:"gain"`
	Offset float64  `json:"offset"`
}

type sensorParams struct {
	Source   sensorSource `json:"source"`
	RangeMin *float64     `json:"rangeMin"`
	RangeMax *float64     `json:"rangeMax"`
	// First-order response time of the sensor; 0 follows the source immediately.
	TimeConstantS float64  `json:"timeConstantS"`
	InitialValue  *float64 `json:"initialValue"`
	// A SENSOR_VALUE_CHANGED event is emitted when the value moves by at least this much.
	EventDeadband *float64 `json:"eventDeadband"`
}

func init() {
	Register("SENSOR", func() Behavior { return &Sensor{} }, func() Description {
		return Description{
			Key:     "SENSOR",
			Version: 1,
			Summary: "A transmitter that reports a value from a constant, ramp, sine, seeded-random or measured source through a first-order lag within its range; signal loss reads bottom of range with bad quality.",
			Signals: []Signal{
				{Key: "value", Direction: Out, Kind: Number, Label: "Measured value"},
				faulted,
			},
			Faults: []Fault{
				{Code: "BAD_QUALITY", Name: "Signal lost", Severity: Warning, Latching: false},
				stuck,
			},
			Links: []Link{{Role: "measures", Meaning: "the device whose output signal a MEASURED source follows; required when the source is MEASURED"}},
			Parameters: mustJSON(map[string]any{
				"source":        map[string]any{"kind": "CONSTANT", "value": 0},
				"timeConstantS": 0,
			}),
			ParameterSchema: []ParameterSpec{
				{Key: "source", Label: "Signal source", Kind: "STRUCTURED", Role: "SOURCE", Default: map[string]any{"kind": "CONSTANT", "value": 0}, Kinds: map[string][]string{
					"CONSTANT": {"value"},
					"RAMP":     {"from", "to", "periodS"},
					"SINE":     {"min", "max", "periodS"},
					"RANDOM":   {"min", "max", "intervalS", "seed"},
					"MEASURED": {"signal", "gain", "offset"},
				}, Description: "Where the value comes from; a MEASURED source follows an output signal of the measured device."},
				{Key: "rangeMin", Label: "Range minimum", Kind: "NUMBER", Role: "LIMIT", Description: "Below rangeMax; the value saturates at it."},
				{Key: "rangeMax", Label: "Range maximum", Kind: "NUMBER", Role: "LIMIT"},
				{Key: "timeConstantS", Label: "Response time constant", Kind: "NUMBER", Role: "TIMING", Unit: "s", Default: 0.0, Min: f64(0), Max: f64(3600), MinInclusive: true, MaxInclusive: true, Description: "First-order response of the sensor; 0 follows the source immediately."},
				{Key: "initialValue", Label: "Initial value", Kind: "NUMBER", Role: "INITIAL"},
				{Key: "eventDeadband", Label: "Event deadband", Kind: "NUMBER", Role: "EVENT", Min: f64(0), Description: "A SENSOR_VALUE_CHANGED event is emitted when the value moves by at least this much."},
			},
			States:     []string{"GOOD", "BAD"},
			Forcible:   true,
			ForcedKind: Number,
		}
	})
}

func (s *Sensor) Profile() string { return "SENSOR" }
func (s *Sensor) Version() int    { return 1 }

func (s *Sensor) Configure(raw json.RawMessage) error {
	params := sensorParams{Source: sensorSource{Kind: "CONSTANT"}}
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	source := &params.Source
	switch source.Kind {
	case "CONSTANT":
		if !finite(source.Value) {
			return &ParamError{Name: "source.value", Reason: "must be a finite number"}
		}
	case "RAMP":
		if !finite(source.From) || !finite(source.To) {
			return &ParamError{Name: "source.from", Reason: "and source.to must be finite numbers"}
		}
		if err := seconds("source.periodS", source.PeriodS); err != nil {
			return err
		}
	case "SINE":
		if !finite(source.Min) || !finite(source.Max) {
			return &ParamError{Name: "source.min", Reason: "and source.max must be finite numbers"}
		}
		if err := seconds("source.periodS", source.PeriodS); err != nil {
			return err
		}
	case "RANDOM":
		if !finite(source.Min) || !finite(source.Max) {
			return &ParamError{Name: "source.min", Reason: "and source.max must be finite numbers"}
		}
		if source.IntervalS == 0 {
			source.IntervalS = 1
		}
		if err := seconds("source.intervalS", source.IntervalS); err != nil {
			return err
		}
		if source.Seed == nil {
			seed := int64(1)
			source.Seed = &seed
		}
	case "MEASURED":
		if source.Signal == "" || len(source.Signal) > 64 {
			return &ParamError{Name: "source.signal", Reason: "must name an output signal of the measured device"}
		}
		if source.Gain == nil {
			gain := 1.0
			source.Gain = &gain
		}
		if !finite(*source.Gain) || !finite(source.Offset) {
			return &ParamError{Name: "source.gain", Reason: "and source.offset must be finite numbers"}
		}
	default:
		return &ParamError{Name: "source.kind", Reason: `must be CONSTANT, RAMP, SINE, RANDOM or MEASURED`}
	}
	if params.RangeMin != nil && params.RangeMax != nil && *params.RangeMin >= *params.RangeMax {
		return &ParamError{Name: "rangeMin", Reason: "must be below rangeMax"}
	}
	if err := within("timeConstantS", params.TimeConstantS, 0, 3600); err != nil {
		return err
	}
	if params.EventDeadband != nil {
		if err := positive("eventDeadband", *params.EventDeadband); err != nil {
			return err
		}
	}
	s.params = params
	initial := 0.0
	if params.RangeMin != nil {
		initial = *params.RangeMin
	}
	if params.InitialValue != nil {
		initial = *params.InitialValue
	}
	seed := int64(1)
	if source.Kind == "RANDOM" {
		seed = *source.Seed
	}
	s.random = mulberry32{state: uint32(seed)}
	s.value, s.lastEmitted = initial, initial
	s.sample, s.nextSample = 0, 0
	s.quality, s.state = "GOOD", "GOOD"
	return nil
}

func (s *Sensor) sourceValue(ctx *Context) float64 {
	source := s.params.Source
	elapsed := ctx.ElapsedS
	switch source.Kind {
	case "CONSTANT":
		return source.Value
	case "RAMP":
		return source.From + (source.To-source.From)*(math.Mod(elapsed, source.PeriodS)/source.PeriodS)
	case "SINE":
		return (source.Min+source.Max)/2 + (source.Max-source.Min)/2*math.Sin(2*math.Pi*elapsed/source.PeriodS)
	case "RANDOM":
		for elapsed >= s.nextSample {
			s.sample = source.Min + (source.Max-source.Min)*s.random.next()
			s.nextSample += source.IntervalS
		}
		return s.sample
	default:
		measured := 0.0
		if peer := ctx.Peer("measures"); peer != nil {
			measured = peer.outputs[source.Signal]
		}
		return measured**source.Gain + source.Offset
	}
}

func (s *Sensor) Step(dt float64, ctx *Context) {
	p := s.params
	if ctx.ActiveFaults["BAD_QUALITY"] {
		// A lost signal reads as the bottom of the range, like an open current loop.
		s.quality = "BAD"
		s.value = 0
		if p.RangeMin != nil {
			s.value = *p.RangeMin
		}
	} else {
		s.quality = "GOOD"
		if !ctx.Tripped && !ctx.ActiveFaults["STUCK"] {
			raw := s.sourceValue(ctx)
			if ctx.Forced != nil {
				raw = *ctx.Forced
			}
			next := raw
			if p.TimeConstantS > 0 {
				next = s.value + (raw-s.value)*(1-math.Exp(-dt/p.TimeConstantS))
			}
			lo, hi := math.Inf(-1), math.Inf(1)
			if p.RangeMin != nil {
				lo = *p.RangeMin
			}
			if p.RangeMax != nil {
				hi = *p.RangeMax
			}
			s.value = clamp(next, lo, hi)
		}
	}
	s.state = s.quality
}

func (s *Sensor) Outputs(ctx *Context) Values {
	return Values{"value": s.value, "faulted": asFloat(reportsFault(ctx))}
}

func (s *Sensor) State() string { return s.state }

func (s *Sensor) Internal() map[string]float64 {
	return map[string]float64{"value": s.value, "good": asFloat(s.quality == "GOOD")}
}

func (s *Sensor) ForcedKind() Kind { return Number }

// Quality of the sensor's value: BAD while its signal is lost.
func (s *Sensor) Quality() string { return s.quality }

// moved says whether the value crossed the event deadband since the last event, and marks it emitted.
func (s *Sensor) moved() bool {
	deadband := s.params.EventDeadband
	if deadband == nil || abs(s.value-s.lastEmitted) < *deadband {
		return false
	}
	s.lastEmitted = s.value
	return true
}
