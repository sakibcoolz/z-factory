package device

import (
	"encoding/json"
	"math"
)

// Motor is a three-phase induction motor: its speed follows the supply frequency with a
// first-order lag; its current grows with the torque the load on its shaft asks for.
// It takes its supply from a drive (link "drive") or, without one, from a contactor
// command. It drives one load (link "motor", made from the load's side). Slip is not
// modelled.
type Motor struct {
	params    motorParams
	speed     float64 // rpm, signed
	current   float64 // A
	energized bool
	state     string
}

type motorParams struct {
	RatedSpeedRpm    float64 `json:"ratedSpeedRpm"`
	RatedFrequencyHz float64 `json:"ratedFrequencyHz"`
	RatedCurrentA    float64 `json:"ratedCurrentA"`
	// Share of the rated current drawn with no load on the shaft.
	NoLoadCurrentRatio float64 `json:"noLoadCurrentRatio"`
	// First-order response of the speed to a change of supply.
	TimeConstantS float64 `json:"timeConstantS"`
	// First-order coast-down once the supply is gone.
	CoastTimeConstantS float64 `json:"coastTimeConstantS"`
}

func defaultMotorParams() motorParams {
	return motorParams{RatedSpeedRpm: 1450, RatedFrequencyHz: 50, RatedCurrentA: 10, NoLoadCurrentRatio: 0.35, TimeConstantS: 0.5, CoastTimeConstantS: 2}
}

func init() {
	Register("MOTOR", func() Behavior { return &Motor{} }, func() Description {
		return Description{
			Key:     "MOTOR",
			Version: 1,
			Summary: "An induction motor whose speed follows its supply frequency with a first-order lag and whose current follows the load torque; direct-on-line from a contactor command when it has no drive.",
			Signals: []Signal{
				{Key: "run", Direction: In, Kind: Bool, Label: "Contactor command (motors without a drive)"},
				faultReset,
				running,
				faulted,
				{Key: "actualSpeed", Direction: Out, Kind: Number, Label: "Actual speed", Unit: "rpm"},
				{Key: "current", Direction: Out, Kind: Number, Label: "Current", Unit: "A"},
			},
			Faults: []Fault{{Code: "OVERLOAD", Name: "Overload trip", Severity: Critical, Latching: true}},
			Links: []Link{
				{Role: "drive", Accepts: []string{"VFD", "RELAY", "SOFT_STARTER", "MOTOR_STARTER"}, Meaning: "the drive, relay, contactor or starter that supplies the motor; one supplies one motor; without one, the run command is a contactor"},
			},
			Parameters: mustJSON(defaultMotorParams()),
			ParameterSchema: []ParameterSpec{
				ratingParam("ratedSpeedRpm", "Rated speed", 1450, "rpm", ""),
				ratingParam("ratedFrequencyHz", "Rated frequency", 50, "Hz", ""),
				ratingParam("ratedCurrentA", "Rated current", 10, "A", ""),
				{Key: "noLoadCurrentRatio", Label: "No-load current ratio", Kind: "NUMBER", Role: "RATING", Default: 0.35, Min: f64(0), Max: f64(1), MinInclusive: true, MaxInclusive: true, Description: "Share of the rated current drawn with no load on the shaft."},
				secondsParam("timeConstantS", "Speed time constant", 0.5, "First-order response of the speed to a change of supply."),
				secondsParam("coastTimeConstantS", "Coast-down time constant", 2, "First-order coast-down once the supply is gone."),
			},
			States: []string{"STOPPED", "RUNNING", "COASTING", "FAULTED"},
		}
	})
}

func (m *Motor) Profile() string { return "MOTOR" }
func (m *Motor) Version() int    { return 1 }

func (m *Motor) Configure(raw json.RawMessage) error {
	params := defaultMotorParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	for name, value := range map[string]float64{"ratedSpeedRpm": params.RatedSpeedRpm, "ratedFrequencyHz": params.RatedFrequencyHz, "ratedCurrentA": params.RatedCurrentA} {
		if err := positive(name, value); err != nil {
			return err
		}
	}
	if err := within("noLoadCurrentRatio", params.NoLoadCurrentRatio, 0, 1); err != nil {
		return err
	}
	for name, value := range map[string]float64{"timeConstantS": params.TimeConstantS, "coastTimeConstantS": params.CoastTimeConstantS} {
		if err := seconds(name, value); err != nil {
			return err
		}
	}
	m.params = params
	m.speed, m.current, m.energized = 0, 0, false
	m.state = "STOPPED"
	return nil
}

func (m *Motor) Step(dt float64, ctx *Context) {
	p := m.params
	supplyHz, limit := 0.0, 0.0
	if !ctx.Tripped {
		if supply, ok := peerSupply(ctx, "drive"); ok {
			state := supply.Supply(ctx)
			if state.Energized {
				supplyHz, limit = state.FrequencyHz, state.SpeedLimit
				if state.Line {
					supplyHz = p.RatedFrequencyHz
				}
			}
		} else if ctx.Inputs.On("run") {
			supplyHz = p.RatedFrequencyHz
		}
	}
	// Speed follows the supply frequency with a first-order lag; a starter that ramps
	// limits it to a share of rated speed meanwhile.
	target := p.RatedSpeedRpm * supplyHz / p.RatedFrequencyHz
	if limit > 0 && abs(target) > p.RatedSpeedRpm*limit {
		target = math.Copysign(p.RatedSpeedRpm*limit, target)
	}
	timeConstant := p.CoastTimeConstantS
	if supplyHz != 0 {
		timeConstant = p.TimeConstantS
	}
	speed := m.speed + (target-m.speed)*(1-math.Exp(-dt/timeConstant))
	if abs(target-speed) < p.RatedSpeedRpm*0.001 {
		speed = target
	}
	m.speed = speed
	m.energized = supplyHz != 0

	n := abs(speed) / p.RatedSpeedRpm
	torque := 0.0
	if peer := ctx.Peer("load"); peer != nil {
		if load, ok := peer.behavior.(Load); ok {
			torque = math.Min(load.Torque(peer.context(), n), 1.5)
		}
	}
	if m.energized {
		m.current = p.RatedCurrentA * (p.NoLoadCurrentRatio + (1-p.NoLoadCurrentRatio)*torque)
	} else {
		m.current = 0
	}

	switch {
	case ctx.Tripped:
		m.state = "FAULTED"
	case m.energized:
		m.state = "RUNNING"
	case n > standstill:
		m.state = "COASTING"
	default:
		m.state = "STOPPED"
	}
}

func (m *Motor) Outputs(ctx *Context) Values {
	return Values{
		"running":     asFloat(m.energized),
		"faulted":     asFloat(reportsFault(ctx)),
		"actualSpeed": abs(m.speed),
		"current":     m.current,
	}
}

func (m *Motor) State() string { return m.state }

func (m *Motor) Internal() map[string]float64 {
	return map[string]float64{"speed": m.speed, "current": m.current, "energized": asFloat(m.energized)}
}

// speedFraction is the shaft speed as a share of rated speed, for the load on it.
func (m *Motor) speedFraction() float64 { return abs(m.speed) / m.params.RatedSpeedRpm }

// peerSupply returns the supply linked under the role, when the device there is one.
func peerSupply(ctx *Context, role string) (Supply, bool) {
	peer := ctx.Peer(role)
	if peer == nil {
		return nil, false
	}
	supply, ok := peer.behavior.(Supply)
	return supply, ok
}
