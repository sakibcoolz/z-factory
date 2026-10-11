package device

import (
	"encoding/json"
	"math"
)

// Controller is a PID process or temperature controller: it measures a process value
// from the device it is linked to (link "measures", the signal named by its source),
// holds a setpoint (the PLC's, else its own), and while enabled computes an output share
// with proportional, integral and derivative action, clamped to its output range with
// anti-windup. In manual the PLC's manual output is passed through. The devices it
// controls (a heater's power, a valve's position: their "controller" link) take its
// output. Approximation: an ideal parallel PID on a fixed step; no auto-tuning, no
// setpoint ramp, no bumpless transfer beyond resetting the integral on enable.
type Controller struct {
	params   controllerParams
	pv       float64
	output   float64
	integral float64
	lastPv   float64
	havePv   bool
	enabled  bool
	manual   bool
	state    string
}

type controllerParams struct {
	Source measuredSource `json:"source"`
	// Gains of the parallel form: output = kp·e + ki·∫e + kd·de/dt, in output % per unit of error.
	Kp float64 `json:"kp"`
	Ki float64 `json:"ki"`
	Kd float64 `json:"kd"`
	// Output range.
	OutputMin float64 `json:"outputMin"`
	OutputMax float64 `json:"outputMax"`
	// Local setpoint, used when the PLC gives none.
	Setpoint float64 `json:"setpoint"`
	// REVERSE: the output rises when the process value is below the setpoint (heating);
	// DIRECT: when it is above (cooling).
	Action string `json:"action"`
	// Error within which the controller reports at setpoint.
	Deadband float64 `json:"deadband"`
	// Process-value alarms; absent means none.
	AlarmHigh *float64 `json:"alarmHigh,omitempty"`
	AlarmLow  *float64 `json:"alarmLow,omitempty"`
}

// measuredSource names an output signal of the measured device, scaled.
type measuredSource struct {
	Kind   string   `json:"kind"`
	Signal string   `json:"signal"`
	Gain   *float64 `json:"gain,omitempty"`
	Offset float64  `json:"offset,omitempty"`
}

func (s *measuredSource) check() error {
	if s.Kind != "MEASURED" {
		return &ParamError{Name: "source.kind", Reason: `must be "MEASURED"`}
	}
	if s.Signal == "" || len(s.Signal) > 64 {
		return &ParamError{Name: "source.signal", Reason: "must name an output signal of the measured device"}
	}
	if s.Gain == nil {
		gain := 1.0
		s.Gain = &gain
	}
	if !finite(*s.Gain) || !finite(s.Offset) {
		return &ParamError{Name: "source.gain", Reason: "and source.offset must be finite numbers"}
	}
	return nil
}

// read takes the signal as the measured device shows it now (its outputs for this step
// when it has already been stepped, else the last ones).
func (s *measuredSource) read(ctx *Context) float64 {
	measured := 0.0
	if peer := ctx.Peer("measures"); peer != nil && peer.status == StatusOK {
		measured = peer.behavior.Outputs(peer.context())[s.Signal]
	} else if peer != nil {
		measured = peer.outputs[s.Signal]
	}
	return measured**s.Gain + s.Offset
}

var measuredKinds = map[string][]string{"MEASURED": {"signal", "gain", "offset"}}

func defaultControllerParams() controllerParams {
	return controllerParams{
		Source:    measuredSource{Kind: "MEASURED", Signal: "value"},
		Kp:        1,
		Ki:        0.1,
		Kd:        0,
		OutputMin: 0,
		OutputMax: 100,
		Setpoint:  0,
		Action:    "REVERSE",
		Deadband:  1,
	}
}

func init() {
	Register("PID_CONTROLLER", func() Behavior { return &Controller{} }, func() Description {
		return Description{
			Key:     "PID_CONTROLLER",
			Version: 1,
			Summary: "A PID process or temperature controller: measures its process value from the device it is linked to, follows the PLC's setpoint or its own, and while enabled computes an output share with proportional, integral and derivative action within its output range; in manual it passes the PLC's manual output through; the devices it controls take its output.",
			Signals: []Signal{
				{Key: "enable", Direction: In, Kind: Bool, Label: "Enable (automatic control)"},
				{Key: "setpoint", Direction: In, Kind: Number, Label: "Remote setpoint"},
				{Key: "manual", Direction: In, Kind: Bool, Label: "Manual mode"},
				{Key: "manualOutput", Direction: In, Kind: Number, Label: "Manual output", Unit: "%"},
				faultReset,
				{Key: "output", Direction: Out, Kind: Number, Label: "Control output", Unit: "%"},
				{Key: "processValue", Direction: Out, Kind: Number, Label: "Process value"},
				{Key: "error", Direction: Out, Kind: Number, Label: "Control error (setpoint minus process value)"},
				{Key: "atSetpoint", Direction: Out, Kind: Bool, Label: "At setpoint"},
				{Key: "alarmHigh", Direction: Out, Kind: Bool, Label: "Process value high"},
				{Key: "alarmLow", Direction: Out, Kind: Bool, Label: "Process value low"},
				faulted,
			},
			Faults: []Fault{
				{Code: "INPUT_FAILURE", Name: "Process input failure", Severity: Critical, Latching: false},
			},
			Links:      []Link{{Role: "measures", Meaning: "the device whose output signal is the process value; required"}},
			Parameters: mustJSON(defaultControllerParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "source", Label: "Process value source", Kind: "STRUCTURED", Role: "SOURCE", Default: map[string]any{"kind": "MEASURED", "signal": "value"}, Kinds: measuredKinds, Description: "The output signal of the measured device that is the process value, scaled by gain and offset."},
				{Key: "kp", Label: "Proportional gain", Kind: "NUMBER", Role: "RATING", Unit: "%/unit", Default: 1.0, Min: f64(0), Max: f64(1000000), MinInclusive: true, MaxInclusive: true},
				{Key: "ki", Label: "Integral gain", Kind: "NUMBER", Role: "TIMING", Unit: "%/(unit·s)", Default: 0.1, Min: f64(0), Max: f64(1000000), MinInclusive: true, MaxInclusive: true},
				{Key: "kd", Label: "Derivative gain", Kind: "NUMBER", Role: "TIMING", Unit: "%·s/unit", Default: 0.0, Min: f64(0), Max: f64(1000000), MinInclusive: true, MaxInclusive: true},
				{Key: "outputMin", Label: "Output minimum", Kind: "NUMBER", Role: "LIMIT", Unit: "%", Default: 0.0},
				{Key: "outputMax", Label: "Output maximum", Kind: "NUMBER", Role: "LIMIT", Unit: "%", Default: 100.0, Description: "Above the output minimum."},
				{Key: "setpoint", Label: "Local setpoint", Kind: "NUMBER", Role: "INITIAL", Default: 0.0, Description: "Used when the PLC gives no setpoint."},
				{Key: "action", Label: "Action", Kind: "CHOICE", Role: "SHAPE", Default: "REVERSE", Choices: []string{"REVERSE", "DIRECT"}, Description: "REVERSE: the output rises when the process value is below the setpoint (heating); DIRECT: when it is above (cooling)."},
				{Key: "deadband", Label: "At-setpoint deadband", Kind: "NUMBER", Role: "LIMIT", Default: 1.0, Min: f64(0), Max: f64(1000000), MinInclusive: true, MaxInclusive: true},
				{Key: "alarmHigh", Label: "High alarm", Kind: "NUMBER", Role: "LIMIT", Description: "Process value at or above it raises the high alarm."},
				{Key: "alarmLow", Label: "Low alarm", Kind: "NUMBER", Role: "LIMIT", Description: "Process value at or below it raises the low alarm."},
			},
			States: []string{"OFF", "AUTO", "MANUAL", "FAULTED"},
		}
	})
}

func (c *Controller) Profile() string { return "PID_CONTROLLER" }
func (c *Controller) Version() int    { return 1 }

func (c *Controller) Configure(raw json.RawMessage) error {
	params := defaultControllerParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := params.Source.check(); err != nil {
		return err
	}
	for name, value := range map[string]float64{"kp": params.Kp, "ki": params.Ki, "kd": params.Kd, "deadband": params.Deadband} {
		if err := within(name, value, 0, 1000000); err != nil {
			return err
		}
	}
	for name, value := range map[string]float64{"outputMin": params.OutputMin, "outputMax": params.OutputMax} {
		if !finite(value) {
			return &ParamError{Name: name, Reason: "must be a finite number"}
		}
	}
	if params.OutputMax <= params.OutputMin {
		return &ParamError{Name: "outputMax", Reason: "must be above outputMin"}
	}
	if !finite(params.Setpoint) {
		return &ParamError{Name: "setpoint", Reason: "must be a finite number"}
	}
	switch params.Action {
	case "REVERSE", "DIRECT":
	default:
		return &ParamError{Name: "action", Reason: `must be "REVERSE" or "DIRECT"`}
	}
	for name, value := range map[string]*float64{"alarmHigh": params.AlarmHigh, "alarmLow": params.AlarmLow} {
		if value != nil && !finite(*value) {
			return &ParamError{Name: name, Reason: "must be a finite number"}
		}
	}
	c.params = params
	c.pv, c.output, c.integral, c.lastPv = 0, params.OutputMin, 0, 0
	c.havePv, c.enabled, c.manual = false, false, false
	c.state = "OFF"
	return nil
}

func (c *Controller) setpoint(ctx *Context) float64 {
	if ctx.Inputs.Has("setpoint") {
		return ctx.Inputs["setpoint"]
	}
	return c.params.Setpoint
}

func (c *Controller) Step(dt float64, ctx *Context) {
	p := c.params
	failed := ctx.ActiveFaults["INPUT_FAILURE"]
	if !failed {
		c.pv = p.Source.read(ctx)
	}
	wasEnabled := c.enabled
	c.enabled = ctx.Inputs.On("enable") && !ctx.Tripped && !failed
	c.manual = c.enabled && ctx.Inputs.On("manual")
	switch {
	case !c.enabled:
		c.output = p.OutputMin
		c.integral = 0
	case c.manual:
		c.output = clamp(ctx.Inputs["manualOutput"], p.OutputMin, p.OutputMax)
		c.integral = 0
	default:
		if !wasEnabled || !c.havePv {
			c.integral, c.lastPv = 0, c.pv
		}
		e := c.setpoint(ctx) - c.pv
		if p.Action == "DIRECT" {
			e = -e
		}
		derivative := 0.0
		if dt > 0 {
			// Derivative on the measurement, so a setpoint step does not kick the output.
			derivative = -(c.pv - c.lastPv) / dt
			if p.Action == "DIRECT" {
				derivative = -derivative
			}
		}
		unclamped := p.Kp*e + p.Ki*(c.integral+e*dt) + p.Kd*derivative
		c.output = clamp(unclamped, p.OutputMin, p.OutputMax)
		// Anti-windup: integrate only while the output is not held at a limit by it.
		if unclamped == c.output || (unclamped > p.OutputMax && e < 0) || (unclamped < p.OutputMin && e > 0) {
			c.integral += e * dt
		}
	}
	c.lastPv, c.havePv = c.pv, true
	switch {
	case ctx.Tripped || failed:
		c.state = "FAULTED"
	case !c.enabled:
		c.state = "OFF"
	case c.manual:
		c.state = "MANUAL"
	default:
		c.state = "AUTO"
	}
}

// Output share the controlled devices take: the output as a share of its range.
func (c *Controller) share() float64 {
	p := c.params
	return (c.output - p.OutputMin) / (p.OutputMax - p.OutputMin)
}

func (c *Controller) Outputs(ctx *Context) Values {
	p := c.params
	e := c.setpoint(ctx) - c.pv
	return Values{
		"output":       c.output,
		"processValue": c.pv,
		"error":        e,
		"atSetpoint":   asFloat(c.enabled && !c.manual && math.Abs(e) <= p.Deadband),
		"alarmHigh":    asFloat(p.AlarmHigh != nil && c.pv >= *p.AlarmHigh),
		"alarmLow":     asFloat(p.AlarmLow != nil && c.pv <= *p.AlarmLow),
		"faulted":      asFloat(reportsFault(ctx)),
	}
}

func (c *Controller) State() string { return c.state }

func (c *Controller) Internal() map[string]float64 {
	return map[string]float64{"pv": c.pv, "output": c.output, "integral": c.integral}
}
