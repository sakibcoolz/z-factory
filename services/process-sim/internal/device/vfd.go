package device

import "encoding/json"

// Common signals of profiles that run and can fault.
var (
	running    = Signal{Key: "running", Direction: Out, Kind: Bool, Label: "Running"}
	faulted    = Signal{Key: "faulted", Direction: Out, Kind: Bool, Label: "Fault active"}
	faultReset = Signal{Key: "faultReset", Direction: In, Kind: Bool, Label: "Fault reset (rising edge)"}
)

// VFD is a variable-frequency drive with hardwired control: run, reverse and a frequency
// setpoint in, a ramped output frequency out. It drives one motor (link "motor", made
// from the motor's side). Approximation: linear ramps; no V/f curve, no torque limit.
type VFD struct {
	params    vfdParams
	frequency float64 // signed: negative is reverse
	state     string
}

type vfdParams struct {
	MaxFrequencyHz float64 `json:"maxFrequencyHz"`
	// Time to ramp from zero to the maximum frequency.
	AccelTimeS float64 `json:"accelTimeS"`
	// Time to ramp from the maximum frequency to zero.
	DecelTimeS float64 `json:"decelTimeS"`
}

func defaultVfdParams() vfdParams { return vfdParams{MaxFrequencyHz: 50, AccelTimeS: 5, DecelTimeS: 5} }

func init() {
	Register("VFD", func() Behavior { return &VFD{} }, func() Description {
		return Description{
			Key:     "VFD",
			Version: 1,
			Summary: "A drive with hardwired control: ramps its output frequency to the setpoint while the run command is on, through zero on a reversal; a trip removes the output at once.",
			Signals: []Signal{
				{Key: "run", Direction: In, Kind: Bool, Label: "Run command"},
				{Key: "reverse", Direction: In, Kind: Bool, Label: "Reverse direction"},
				{Key: "frequencySetpoint", Direction: In, Kind: Number, Label: "Frequency setpoint", Unit: "Hz"},
				faultReset,
				running,
				{Key: "atSetpoint", Direction: Out, Kind: Bool, Label: "At setpoint"},
				faulted,
				{Key: "actualFrequency", Direction: Out, Kind: Number, Label: "Actual frequency", Unit: "Hz"},
				{Key: "outputCurrent", Direction: Out, Kind: Number, Label: "Output current", Unit: "A"},
			},
			Faults: []Fault{
				{Code: "OVERCURRENT", Name: "Overcurrent trip", Severity: Critical, Latching: true},
				{Code: "OVERTEMPERATURE", Name: "Overtemperature trip", Severity: Critical, Latching: true},
			},
			Parameters: mustJSON(defaultVfdParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "maxFrequencyHz", Label: "Maximum output frequency", Kind: "NUMBER", Role: "RATING", Unit: "Hz", Default: 50.0, Min: f64(0), Max: f64(1000), MaxInclusive: true},
				secondsParam("accelTimeS", "Acceleration time", 5, "Time to ramp from zero to the maximum frequency."),
				secondsParam("decelTimeS", "Deceleration time", 5, "Time to ramp from the maximum frequency to zero."),
			},
			States: []string{"STOPPED", "ACCELERATING", "RUNNING", "DECELERATING", "FAULTED"},
		}
	})
}

func (v *VFD) Profile() string { return "VFD" }
func (v *VFD) Version() int    { return 1 }

func (v *VFD) Configure(raw json.RawMessage) error {
	params := defaultVfdParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := positive("maxFrequencyHz", params.MaxFrequencyHz); err != nil {
		return err
	}
	if params.MaxFrequencyHz > 1000 {
		return &ParamError{Name: "maxFrequencyHz", Reason: "must be at most 1000 Hz"}
	}
	for name, value := range map[string]float64{"accelTimeS": params.AccelTimeS, "decelTimeS": params.DecelTimeS} {
		if err := seconds(name, value); err != nil {
			return err
		}
	}
	v.params = params
	v.frequency = 0
	v.state = "STOPPED"
	return nil
}

func (v *VFD) Step(dt float64, ctx *Context) {
	if ctx.Tripped {
		// A tripped drive removes its output at once; the motor coasts.
		v.frequency = 0
		v.state = "FAULTED"
		return
	}
	magnitude := clamp(ctx.Inputs["frequencySetpoint"], 0, v.params.MaxFrequencyHz)
	target := 0.0
	if ctx.Inputs.On("run") {
		target = magnitude
		if ctx.Inputs.On("reverse") {
			target = -magnitude
		}
	}
	// A change of direction first ramps down to zero, then up the other way.
	reversing := v.frequency != 0 && target != 0 && (v.frequency < 0) != (target < 0)
	accelerating := !reversing && abs(target) > abs(v.frequency)
	rate := v.params.MaxFrequencyHz / v.params.DecelTimeS
	if accelerating {
		rate = v.params.MaxFrequencyHz / v.params.AccelTimeS
	}
	goal := target
	if reversing {
		goal = 0
	}
	v.frequency = approach(v.frequency, goal, rate*dt)
	switch {
	case v.frequency == target && target == 0:
		v.state = "STOPPED"
	case v.frequency == target:
		v.state = "RUNNING"
	case accelerating:
		v.state = "ACCELERATING"
	default:
		v.state = "DECELERATING"
	}
}

func (v *VFD) Outputs(ctx *Context) Values {
	current := 0.0
	if motor, ok := peerBehavior[*Motor](ctx, "motor"); ok && v.frequency != 0 {
		current = motor.current
	}
	return Values{
		"running":         asFloat(!ctx.Tripped && (ctx.Inputs.On("run") || v.frequency != 0)),
		"atSetpoint":      asFloat(v.state == "RUNNING"),
		"faulted":         asFloat(reportsFault(ctx)),
		"actualFrequency": abs(v.frequency),
		"outputCurrent":   current,
	}
}

func (v *VFD) State() string { return v.state }

// Supply of the motor the drive feeds: its output frequency.
func (v *VFD) Supply(_ *Context) SupplyState {
	return SupplyState{Energized: v.frequency != 0, FrequencyHz: v.frequency}
}

func (v *VFD) Internal() map[string]float64 { return map[string]float64{"frequency": v.frequency} }

func abs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

// peerBehavior returns the behaviour of the device linked under the role when it is of type T.
func peerBehavior[T Behavior](ctx *Context, role string) (T, bool) {
	var zero T
	peer := ctx.Peer(role)
	if peer == nil {
		return zero, false
	}
	behavior, ok := peer.behavior.(T)
	return behavior, ok
}
