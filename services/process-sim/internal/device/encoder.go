package device

import (
	"encoding/json"
	"math"
)

// Encoder measures a shaft (link "measures": a motor or a servo motor) and reports a
// pulse count and the speed. An incremental encoder accumulates counts from the shaft's
// motion since the start; an absolute single-turn encoder reports the position within one
// revolution. A motor's shaft is taken from its speed, a servo motor's from its position.
// Approximation: no quadrature, no index pulse, no multi-turn, no resolution loss. Lost
// signal freezes the count, reads zero speed and is BAD quality; it is not reported.
type Encoder struct {
	params      encoderParams
	revolutions float64
	speedRpm    float64
	quality     string
	state       string
}

type encoderParams struct {
	// INCREMENTAL counts accumulate; ABSOLUTE reports the position within one revolution.
	Kind                string  `json:"kind"`
	PulsesPerRevolution float64 `json:"pulsesPerRevolution"`
	UnitsPerRevolution  float64 `json:"unitsPerRevolution"`
}

func defaultEncoderParams() encoderParams {
	return encoderParams{Kind: "INCREMENTAL", PulsesPerRevolution: 1024, UnitsPerRevolution: 1}
}

func init() {
	Register("ENCODER", func() Behavior { return &Encoder{} }, func() Description {
		return Description{
			Key:     "ENCODER",
			Version: 1,
			Summary: "An encoder on a shaft: counts pulses from a motor's speed or a servo motor's position, accumulating (incremental) or within one revolution (absolute single-turn), and reports the speed; a lost signal freezes the count with bad quality.",
			Signals: []Signal{
				{Key: "count", Direction: Out, Kind: Number, Label: "Pulse count", Unit: "pulses"},
				{Key: "speed", Direction: Out, Kind: Number, Label: "Shaft speed", Unit: "rpm"},
			},
			Faults: []Fault{
				{Code: "SIGNAL_LOSS", Name: "Signal lost", Severity: Warning, Latching: false, Silent: true},
			},
			Links:      []Link{{Role: "measures", Accepts: []string{"MOTOR", "SERVO_MOTOR"}, Meaning: "the motor or servo motor whose shaft the encoder is on"}},
			Parameters: mustJSON(defaultEncoderParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "kind", Label: "Kind", Kind: "CHOICE", Role: "SHAPE", Default: "INCREMENTAL", Choices: []string{"INCREMENTAL", "ABSOLUTE"}, Description: "Incremental counts accumulate; absolute reports the position within one revolution."},
				{Key: "pulsesPerRevolution", Label: "Pulses per revolution", Kind: "NUMBER", Role: "RATING", Unit: "pulses", Default: 1024.0, Min: f64(0), Max: f64(1000000), MaxInclusive: true},
				ratingParam("unitsPerRevolution", "Units per revolution", 1, "units", "How many position units of a servo motor make one revolution."),
			},
			States: []string{"GOOD", "BAD"},
		}
	})
}

func (e *Encoder) Profile() string { return "ENCODER" }
func (e *Encoder) Version() int    { return 1 }

func (e *Encoder) Configure(raw json.RawMessage) error {
	params := defaultEncoderParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	switch params.Kind {
	case "INCREMENTAL", "ABSOLUTE":
	default:
		return &ParamError{Name: "kind", Reason: `must be "INCREMENTAL" or "ABSOLUTE"`}
	}
	if err := positive("pulsesPerRevolution", params.PulsesPerRevolution); err != nil {
		return err
	}
	if params.PulsesPerRevolution > 1000000 {
		return &ParamError{Name: "pulsesPerRevolution", Reason: "must be at most 1000000"}
	}
	if err := positive("unitsPerRevolution", params.UnitsPerRevolution); err != nil {
		return err
	}
	e.params = params
	e.revolutions, e.speedRpm = 0, 0
	e.quality, e.state = "GOOD", "GOOD"
	return nil
}

// Observes marks the encoder as an observer: stepped after the shaft it measures.
func (e *Encoder) Observes() {}

func (e *Encoder) Step(dt float64, ctx *Context) {
	if ctx.ActiveFaults["SIGNAL_LOSS"] {
		e.quality, e.state = "BAD", "BAD"
		e.speedRpm = 0
		return
	}
	e.quality, e.state = "GOOD", "GOOD"
	if peer := ctx.Peer("measures"); peer != nil {
		if position, ok := peer.outputs["actualPosition"]; ok {
			revolutions := position / e.params.UnitsPerRevolution
			if dt > 0 {
				e.speedRpm = (revolutions - e.revolutions) / dt * 60
			}
			e.revolutions = revolutions
		} else {
			e.speedRpm = peer.outputs["actualSpeed"]
			e.revolutions += e.speedRpm / 60 * dt
		}
	}
}

func (e *Encoder) Outputs(_ *Context) Values {
	count := e.revolutions * e.params.PulsesPerRevolution
	if e.params.Kind == "ABSOLUTE" {
		count = math.Mod(count, e.params.PulsesPerRevolution)
		if count < 0 {
			count += e.params.PulsesPerRevolution
		}
	}
	return Values{"count": math.Round(count), "speed": e.speedRpm}
}

func (e *Encoder) State() string { return e.state }

func (e *Encoder) Internal() map[string]float64 {
	return map[string]float64{"revolutions": e.revolutions, "speedRpm": e.speedRpm}
}

// Quality of the count: BAD while the signal is lost.
func (e *Encoder) Quality() string { return e.quality }
