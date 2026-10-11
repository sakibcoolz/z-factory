package device

import "encoding/json"

// SoftStarter is a reduced-voltage starter: on the run command it ramps its output
// voltage from the initial voltage to full over the ramp time, then closes its bypass;
// on stop it ramps down over the ramp-down time (at once when that is zero). The motor
// it feeds runs at line frequency, its speed limited to the voltage share while the
// starter ramps. Approximation: a linear voltage ramp and a speed limit proportional to
// it; no torque curve, current limit, kick start or braking.
type SoftStarter struct {
	params  softStarterParams
	voltage float64 // 0…100 %
	state   string
}

type softStarterParams struct {
	// Output voltage at the start of the ramp.
	InitialVoltagePct float64 `json:"initialVoltagePct"`
	// Time from the initial voltage to full voltage.
	RampTimeS float64 `json:"rampTimeS"`
	// Time from full voltage to zero on stop; zero stops at once.
	RampDownTimeS float64 `json:"rampDownTimeS"`
}

func defaultSoftStarterParams() softStarterParams {
	return softStarterParams{InitialVoltagePct: 30, RampTimeS: 5, RampDownTimeS: 0}
}

func init() {
	Register("SOFT_STARTER", func() Behavior { return &SoftStarter{} }, func() Description {
		return Description{
			Key:     "SOFT_STARTER",
			Version: 1,
			Summary: "A reduced-voltage starter: ramps its output voltage from the initial voltage to full over the ramp time and closes its bypass, ramps down on stop, and limits the motor's speed to the voltage share while it ramps; a trip removes the output at once.",
			Signals: []Signal{
				{Key: "run", Direction: In, Kind: Bool, Label: "Run command"},
				faultReset,
				running,
				{Key: "bypassed", Direction: Out, Kind: Bool, Label: "Bypass closed (full voltage)"},
				faulted,
				{Key: "outputVoltage", Direction: Out, Kind: Number, Label: "Output voltage", Unit: "%"},
				{Key: "outputCurrent", Direction: Out, Kind: Number, Label: "Output current", Unit: "A"},
			},
			Faults: []Fault{
				{Code: "OVERCURRENT", Name: "Overcurrent trip", Severity: Critical, Latching: true},
				{Code: "OVERTEMPERATURE", Name: "Overtemperature trip", Severity: Critical, Latching: true},
			},
			Parameters: mustJSON(defaultSoftStarterParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "initialVoltagePct", Label: "Initial voltage", Kind: "NUMBER", Role: "RATING", Unit: "%", Default: 30.0, Min: f64(0), Max: f64(100), MinInclusive: true, MaxInclusive: true, Description: "Output voltage at the start of the ramp."},
				secondsParam("rampTimeS", "Ramp time", 5, "Time from the initial voltage to full voltage."),
				{Key: "rampDownTimeS", Label: "Ramp-down time", Kind: "NUMBER", Role: "TIMING", Unit: "s", Default: 0.0, Min: f64(0), Max: f64(3600), MinInclusive: true, MaxInclusive: true, Description: "Time from full voltage to zero on stop; zero stops at once."},
			},
			States: []string{"STOPPED", "RAMPING_UP", "BYPASSED", "RAMPING_DOWN", "FAULTED"},
		}
	})
}

func (s *SoftStarter) Profile() string { return "SOFT_STARTER" }
func (s *SoftStarter) Version() int    { return 1 }

func (s *SoftStarter) Configure(raw json.RawMessage) error {
	params := defaultSoftStarterParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := within("initialVoltagePct", params.InitialVoltagePct, 0, 100); err != nil {
		return err
	}
	if err := seconds("rampTimeS", params.RampTimeS); err != nil {
		return err
	}
	if err := within("rampDownTimeS", params.RampDownTimeS, 0, 3600); err != nil {
		return err
	}
	s.params = params
	s.voltage = 0
	s.state = "STOPPED"
	return nil
}

func (s *SoftStarter) Step(dt float64, ctx *Context) {
	p := s.params
	switch {
	case ctx.Tripped:
		s.voltage = 0
		s.state = "FAULTED"
	case ctx.Inputs.On("run"):
		if s.voltage < p.InitialVoltagePct {
			s.voltage = p.InitialVoltagePct
		}
		s.voltage = approach(s.voltage, 100, (100-p.InitialVoltagePct)/p.RampTimeS*dt)
		if s.voltage >= 100 {
			s.state = "BYPASSED"
		} else {
			s.state = "RAMPING_UP"
		}
	case s.voltage > 0 && p.RampDownTimeS > 0:
		s.voltage = approach(s.voltage, 0, 100/p.RampDownTimeS*dt)
		if s.voltage > 0 {
			s.state = "RAMPING_DOWN"
		} else {
			s.state = "STOPPED"
		}
	default:
		s.voltage = 0
		s.state = "STOPPED"
	}
}

func (s *SoftStarter) Outputs(ctx *Context) Values {
	current := 0.0
	if motor, ok := peerBehavior[*Motor](ctx, "motor"); ok && s.voltage > 0 {
		current = motor.current
	}
	return Values{
		"running":       asFloat(s.voltage > 0),
		"bypassed":      asFloat(s.voltage >= 100),
		"faulted":       asFloat(reportsFault(ctx)),
		"outputVoltage": s.voltage,
		"outputCurrent": current,
	}
}

func (s *SoftStarter) State() string { return s.state }

func (s *SoftStarter) Internal() map[string]float64 { return map[string]float64{"voltage": s.voltage} }

// Supply of the motor: the line, limited to the voltage share while the starter ramps.
func (s *SoftStarter) Supply(_ *Context) SupplyState {
	limit := s.voltage / 100
	if s.voltage >= 100 {
		limit = 0
	}
	return SupplyState{Energized: s.voltage > 0, Line: true, SpeedLimit: limit}
}
