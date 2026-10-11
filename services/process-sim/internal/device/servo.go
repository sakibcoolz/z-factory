package device

import (
	"encoding/json"
	"math"
)

// ServoDrive positions its servo motor (link "motor", made from the motor's side): while
// enabled it moves the shaft to the position setpoint with a trapezoidal profile limited
// by the maximum velocity, the acceleration and the deceleration, and reports position,
// velocity and in-position. Disabled, the shaft holds where it is. Approximation: an
// ideal profile with no following error of its own; no current loop, no torque limit,
// no homing. Positions are in generic units (counts, millimetres, degrees: the catalog
// decides).
type ServoDrive struct {
	params   servoDriveParams
	position float64
	velocity float64
	enabled  bool
	state    string
}

type servoDriveParams struct {
	MaxVelocity  float64 `json:"maxVelocity"`
	Acceleration float64 `json:"acceleration"`
	Deceleration float64 `json:"deceleration"`
	// Distance from the setpoint within which the drive reports in position.
	InPositionWindow float64 `json:"inPositionWindow"`
	InitialPosition  float64 `json:"initialPosition"`
}

func defaultServoDriveParams() servoDriveParams {
	return servoDriveParams{MaxVelocity: 1000, Acceleration: 5000, Deceleration: 5000, InPositionWindow: 1, InitialPosition: 0}
}

func init() {
	Register("SERVO_DRIVE", func() Behavior { return &ServoDrive{} }, func() Description {
		return Description{
			Key:     "SERVO_DRIVE",
			Version: 1,
			Summary: "A servo drive: enabled, it moves its motor to the position setpoint with a trapezoidal profile under its velocity, acceleration and deceleration limits and reports position, velocity and in-position; disabled, the shaft holds; a trip disables it at once.",
			Signals: []Signal{
				{Key: "enable", Direction: In, Kind: Bool, Label: "Enable"},
				{Key: "positionSetpoint", Direction: In, Kind: Number, Label: "Position setpoint", Unit: "units"},
				faultReset,
				{Key: "enabled", Direction: Out, Kind: Bool, Label: "Enabled"},
				{Key: "inPosition", Direction: Out, Kind: Bool, Label: "In position"},
				{Key: "moving", Direction: Out, Kind: Bool, Label: "Moving"},
				faulted,
				{Key: "actualPosition", Direction: Out, Kind: Number, Label: "Actual position", Unit: "units"},
				{Key: "actualVelocity", Direction: Out, Kind: Number, Label: "Actual velocity", Unit: "units/s"},
			},
			Faults: []Fault{
				{Code: "FOLLOWING_ERROR", Name: "Following error", Severity: Critical, Latching: true},
				{Code: "OVERCURRENT", Name: "Overcurrent trip", Severity: Critical, Latching: true},
			},
			Parameters: mustJSON(defaultServoDriveParams()),
			ParameterSchema: []ParameterSpec{
				ratingParam("maxVelocity", "Maximum velocity", 1000, "units/s", ""),
				ratingParam("acceleration", "Acceleration", 5000, "units/s²", ""),
				ratingParam("deceleration", "Deceleration", 5000, "units/s²", ""),
				ratingParam("inPositionWindow", "In-position window", 1, "units", "Distance from the setpoint within which the drive reports in position."),
				{Key: "initialPosition", Label: "Initial position", Kind: "NUMBER", Role: "INITIAL", Unit: "units", Default: 0.0},
			},
			States: []string{"DISABLED", "HOLDING", "MOVING", "FAULTED"},
		}
	})
}

func (d *ServoDrive) Profile() string { return "SERVO_DRIVE" }
func (d *ServoDrive) Version() int    { return 1 }

func (d *ServoDrive) Configure(raw json.RawMessage) error {
	params := defaultServoDriveParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	for name, value := range map[string]float64{"maxVelocity": params.MaxVelocity, "acceleration": params.Acceleration, "deceleration": params.Deceleration, "inPositionWindow": params.InPositionWindow} {
		if err := positive(name, value); err != nil {
			return err
		}
	}
	if !finite(params.InitialPosition) {
		return &ParamError{Name: "initialPosition", Reason: "must be a finite number"}
	}
	d.params = params
	d.position, d.velocity = params.InitialPosition, 0
	d.enabled = false
	d.state = "DISABLED"
	return nil
}

func (d *ServoDrive) Step(dt float64, ctx *Context) {
	p := d.params
	d.enabled = ctx.Inputs.On("enable") && !ctx.Tripped
	if !d.enabled || dt == 0 {
		d.velocity = 0
	} else {
		target := d.position
		if ctx.Inputs.Has("positionSetpoint") {
			target = ctx.Inputs["positionSetpoint"]
		}
		remaining := target - d.position
		direction := math.Copysign(1, remaining)
		// Velocity the profile may still have and stop within the remaining distance.
		stoppable := math.Sqrt(2 * p.Deceleration * math.Abs(remaining))
		wanted := direction * math.Min(p.MaxVelocity, stoppable)
		if math.Abs(remaining) < 1e-9 {
			wanted = 0
		}
		// Accelerate towards the wanted velocity, decelerate away from it.
		rate := p.Acceleration
		if math.Abs(wanted) < math.Abs(d.velocity) || wanted*d.velocity < 0 {
			rate = p.Deceleration
		}
		d.velocity = approach(d.velocity, wanted, rate*dt)
		step := d.velocity * dt
		if math.Abs(step) >= math.Abs(remaining) && wanted*remaining >= 0 {
			d.position = target
			d.velocity = 0
		} else {
			d.position += step
		}
	}
	switch {
	case ctx.Tripped:
		d.state = "FAULTED"
	case !d.enabled:
		d.state = "DISABLED"
	case d.velocity != 0:
		d.state = "MOVING"
	default:
		d.state = "HOLDING"
	}
}

func (d *ServoDrive) inPosition(ctx *Context) bool {
	if !d.enabled || !ctx.Inputs.Has("positionSetpoint") {
		return false
	}
	return math.Abs(ctx.Inputs["positionSetpoint"]-d.position) <= d.params.InPositionWindow && d.velocity == 0
}

func (d *ServoDrive) Outputs(ctx *Context) Values {
	return Values{
		"enabled":        asFloat(d.enabled),
		"inPosition":     asFloat(d.inPosition(ctx)),
		"moving":         asFloat(d.velocity != 0),
		"faulted":        asFloat(reportsFault(ctx)),
		"actualPosition": d.position,
		"actualVelocity": d.velocity,
	}
}

func (d *ServoDrive) State() string { return d.state }

func (d *ServoDrive) Internal() map[string]float64 {
	return map[string]float64{"position": d.position, "velocity": d.velocity}
}

// ServoMotor is the motor a servo drive positions (link "drive"): its shaft follows the
// drive's profile exactly, and its current is a holding share plus a share proportional
// to the velocity. Approximation: no inertia of its own, no torque, no thermal model
// beyond the injected overtemperature trip.
type ServoMotor struct {
	params   servoMotorParams
	position float64
	velocity float64
	current  float64
	state    string
}

type servoMotorParams struct {
	RatedCurrentA float64 `json:"ratedCurrentA"`
	// Share of the rated current drawn while holding position.
	HoldingCurrentRatio float64 `json:"holdingCurrentRatio"`
	// Velocity at which the current reaches the rating.
	RatedVelocity float64 `json:"ratedVelocity"`
}

func defaultServoMotorParams() servoMotorParams {
	return servoMotorParams{RatedCurrentA: 5, HoldingCurrentRatio: 0.1, RatedVelocity: 1000}
}

func init() {
	Register("SERVO_MOTOR", func() Behavior { return &ServoMotor{} }, func() Description {
		return Description{
			Key:     "SERVO_MOTOR",
			Version: 1,
			Summary: "A servo motor: its shaft follows its servo drive's profile and its current is a holding share plus a share proportional to the velocity; without a drive it stands still.",
			Signals: []Signal{
				faultReset,
				running,
				faulted,
				{Key: "actualPosition", Direction: Out, Kind: Number, Label: "Shaft position", Unit: "units"},
				{Key: "actualVelocity", Direction: Out, Kind: Number, Label: "Shaft velocity", Unit: "units/s"},
				{Key: "current", Direction: Out, Kind: Number, Label: "Current", Unit: "A"},
			},
			Faults: []Fault{
				{Code: "OVERTEMPERATURE", Name: "Overtemperature trip", Severity: Critical, Latching: true},
			},
			Links: []Link{
				{Role: "drive", Accepts: []string{"SERVO_DRIVE"}, Meaning: "the servo drive that positions the motor; one drive positions one motor"},
			},
			Parameters: mustJSON(defaultServoMotorParams()),
			ParameterSchema: []ParameterSpec{
				ratingParam("ratedCurrentA", "Rated current", 5, "A", ""),
				{Key: "holdingCurrentRatio", Label: "Holding current ratio", Kind: "NUMBER", Role: "RATING", Default: 0.1, Min: f64(0), Max: f64(1), MinInclusive: true, MaxInclusive: true, Description: "Share of the rated current drawn while holding position."},
				ratingParam("ratedVelocity", "Rated velocity", 1000, "units/s", "Velocity at which the current reaches the rating."),
			},
			States: []string{"STOPPED", "HOLDING", "MOVING", "FAULTED"},
		}
	})
}

func (m *ServoMotor) Profile() string { return "SERVO_MOTOR" }
func (m *ServoMotor) Version() int    { return 1 }

func (m *ServoMotor) Configure(raw json.RawMessage) error {
	params := defaultServoMotorParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	for name, value := range map[string]float64{"ratedCurrentA": params.RatedCurrentA, "ratedVelocity": params.RatedVelocity} {
		if err := positive(name, value); err != nil {
			return err
		}
	}
	if err := within("holdingCurrentRatio", params.HoldingCurrentRatio, 0, 1); err != nil {
		return err
	}
	m.params = params
	m.position, m.velocity, m.current = 0, 0, 0
	m.state = "STOPPED"
	return nil
}

func (m *ServoMotor) Step(_ float64, ctx *Context) {
	p := m.params
	drive, ok := peerBehavior[*ServoDrive](ctx, "drive")
	energized := ok && drive.enabled && !ctx.Tripped
	if ok {
		m.position = drive.position
		m.velocity = drive.velocity
	} else {
		m.velocity = 0
	}
	if energized {
		m.current = p.RatedCurrentA * math.Min(1.5, p.HoldingCurrentRatio+(1-p.HoldingCurrentRatio)*math.Abs(m.velocity)/p.RatedVelocity)
	} else {
		m.current, m.velocity = 0, 0
	}
	switch {
	case ctx.Tripped:
		m.state = "FAULTED"
	case !energized:
		m.state = "STOPPED"
	case m.velocity != 0:
		m.state = "MOVING"
	default:
		m.state = "HOLDING"
	}
}

func (m *ServoMotor) Outputs(ctx *Context) Values {
	return Values{
		"running":        asFloat(m.current > 0),
		"faulted":        asFloat(reportsFault(ctx)),
		"actualPosition": m.position,
		"actualVelocity": m.velocity,
		"current":        m.current,
	}
}

func (m *ServoMotor) State() string { return m.state }

func (m *ServoMotor) Internal() map[string]float64 {
	return map[string]float64{"position": m.position, "velocity": m.velocity, "current": m.current}
}
