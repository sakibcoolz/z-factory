package device

import (
	"encoding/json"
	"math"
)

// MotorStarter is a direct-on-line starter with an overload relay: the run command
// closes its contactor and the motor runs at line frequency; a thermal model of the
// overload relay accumulates while the motor's current exceeds the setting and trips the
// starter (the OVERLOAD fault, latching) when it reaches its limit; it cools when the
// current is below the setting. Approximation: a single thermal image whose time to trip
// follows the trip class at 7.2 times the setting; no phase loss, no earth fault, no
// contactor delay.
type MotorStarter struct {
	params motorStarterParams
	closed bool
	// Thermal image of the overload relay: 0 cold, 1 trips.
	thermal float64
	state   string
}

type motorStarterParams struct {
	// Current setting of the overload relay.
	OverloadSettingA float64 `json:"overloadSettingA"`
	// Trip class: seconds to trip from cold at 7.2 times the setting (10, 20, 30).
	TripClass float64 `json:"tripClass"`
	// Time constant of cooling below the setting.
	CoolingTimeS float64 `json:"coolingTimeS"`
}

func defaultMotorStarterParams() motorStarterParams {
	return motorStarterParams{OverloadSettingA: 10, TripClass: 10, CoolingTimeS: 120}
}

func init() {
	Register("MOTOR_STARTER", func() Behavior { return &MotorStarter{} }, func() Description {
		return Description{
			Key:     "MOTOR_STARTER",
			Version: 1,
			Summary: "A direct-on-line starter with an overload relay: the run command closes its contactor and the motor runs at line frequency; the relay's thermal image grows while the motor's current exceeds the setting, trips the starter when it reaches its limit, and cools below the setting.",
			Signals: []Signal{
				{Key: "run", Direction: In, Kind: Bool, Label: "Run command"},
				faultReset,
				running,
				faulted,
				{Key: "current", Direction: Out, Kind: Number, Label: "Motor current", Unit: "A"},
				{Key: "thermalLoad", Direction: Out, Kind: Number, Label: "Overload relay thermal load", Unit: "%"},
			},
			Faults: []Fault{
				{Code: "OVERLOAD", Name: "Overload trip", Severity: Critical, Latching: true},
			},
			Parameters: mustJSON(defaultMotorStarterParams()),
			ParameterSchema: []ParameterSpec{
				ratingParam("overloadSettingA", "Overload setting", 10, "A", "Current setting of the overload relay."),
				{Key: "tripClass", Label: "Trip class", Kind: "NUMBER", Role: "TIMING", Unit: "s", Default: 10.0, Min: f64(0), Max: f64(60), MaxInclusive: true, Description: "Seconds to trip from cold at 7.2 times the setting (class 10, 20, 30)."},
				secondsParam("coolingTimeS", "Cooling time constant", 120, "Time constant of the thermal image cooling below the setting."),
			},
			States: []string{"STOPPED", "RUNNING", "FAULTED"},
		}
	})
}

func (m *MotorStarter) Profile() string { return "MOTOR_STARTER" }
func (m *MotorStarter) Version() int    { return 1 }

func (m *MotorStarter) Configure(raw json.RawMessage) error {
	params := defaultMotorStarterParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := positive("overloadSettingA", params.OverloadSettingA); err != nil {
		return err
	}
	if err := positive("tripClass", params.TripClass); err != nil {
		return err
	}
	if params.TripClass > 60 {
		return &ParamError{Name: "tripClass", Reason: "must be at most 60 seconds"}
	}
	if err := seconds("coolingTimeS", params.CoolingTimeS); err != nil {
		return err
	}
	m.params = params
	m.closed, m.thermal = false, 0
	m.state = "STOPPED"
	return nil
}

// Multiple of the setting the trip class is defined at.
const tripClassMultiple = 7.2

func (m *MotorStarter) current(ctx *Context) float64 {
	if motor, ok := peerBehavior[*Motor](ctx, "motor"); ok && m.closed {
		return motor.current
	}
	return 0
}

func (m *MotorStarter) Step(dt float64, ctx *Context) {
	p := m.params
	m.closed = ctx.Inputs.On("run") && !ctx.Tripped
	// The thermal image: heats as the square of the overload, so that it reaches 1 after
	// the trip class time at 7.2 times the setting; cools with its time constant below.
	ratio := m.current(ctx) / p.OverloadSettingA
	if ratio > 1 {
		m.thermal += (ratio*ratio - 1) / (p.TripClass * (tripClassMultiple*tripClassMultiple - 1)) * dt
	} else {
		m.thermal *= math.Exp(-dt / p.CoolingTimeS)
	}
	if m.thermal >= 1 {
		m.thermal = 1
		ctx.Raise("OVERLOAD")
	}
	switch {
	case ctx.Tripped:
		m.state = "FAULTED"
	case m.closed:
		m.state = "RUNNING"
	default:
		m.state = "STOPPED"
	}
}

func (m *MotorStarter) Outputs(ctx *Context) Values {
	return Values{
		"running":     asFloat(m.closed),
		"faulted":     asFloat(reportsFault(ctx)),
		"current":     m.current(ctx),
		"thermalLoad": m.thermal * 100,
	}
}

func (m *MotorStarter) State() string { return m.state }

func (m *MotorStarter) Internal() map[string]float64 {
	return map[string]float64{"closed": asFloat(m.closed), "thermal": m.thermal}
}

// Supply of the motor: the line while the contactor is closed.
func (m *MotorStarter) Supply(_ *Context) SupplyState {
	return SupplyState{Energized: m.closed, Line: true}
}
