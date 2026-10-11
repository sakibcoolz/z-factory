package device

import (
	"encoding/json"
	"math"
)

// Heater is an electric heating element with a thermal mass: on (through its contactor
// when it has one, else the PLC's on command) and an optional power share (its
// controller's output when it has one), it warms with
// a first-order lag towards ambient plus its rise at that power, and cools the same way
// when off. A thermostat cutout removes power above the maximum temperature until the
// element has cooled by the hysteresis. Approximation: one lumped mass, one time
// constant, a rise proportional to power; no element resistance, no supply voltage, no
// radiation or air flow.
type Heater struct {
	params      heaterParams
	temperature float64
	power       float64 // 0…1 share of rated power delivered
	cutout      bool
	state       string
}

type heaterParams struct {
	// Electrical power at full output.
	RatedPowerKw float64 `json:"ratedPowerKw"`
	// Temperature the element rests at when off.
	AmbientC float64 `json:"ambientC"`
	// Steady-state rise above ambient at full power.
	RiseAtFullPowerC float64 `json:"riseAtFullPowerC"`
	// First-order time constant of heating and cooling.
	TimeConstantS float64 `json:"timeConstantS"`
	// Thermostat cutout: no power above this temperature …
	MaxTemperatureC float64 `json:"maxTemperatureC"`
	// … until the element has cooled by this much.
	CutoutHysteresisC float64 `json:"cutoutHysteresisC"`
	// Temperature at the start.
	InitialTemperatureC *float64 `json:"initialTemperatureC,omitempty"`
}

func defaultHeaterParams() heaterParams {
	return heaterParams{RatedPowerKw: 5, AmbientC: 20, RiseAtFullPowerC: 100, TimeConstantS: 300, MaxTemperatureC: 250, CutoutHysteresisC: 10}
}

func init() {
	Register("HEATER", func() Behavior { return &Heater{} }, func() Description {
		return Description{
			Key:     "HEATER",
			Version: 1,
			Summary: "A heating element with a thermal mass: energized through its contactor or the on command, at the commanded power share, it warms with a first-order lag towards ambient plus its rise at that power, cools the same way when off, and cuts out above its maximum temperature.",
			Signals: []Signal{
				{Key: "on", Direction: In, Kind: Bool, Label: "On command (heaters without a contactor)"},
				{Key: "power", Direction: In, Kind: Number, Label: "Power share", Unit: "%"},
				faultReset,
				{Key: "heating", Direction: Out, Kind: Bool, Label: "Heating"},
				{Key: "temperature", Direction: Out, Kind: Number, Label: "Element temperature", Unit: "°C"},
				{Key: "powerOutput", Direction: Out, Kind: Number, Label: "Power delivered", Unit: "kW"},
				{Key: "cutout", Direction: Out, Kind: Bool, Label: "Thermostat cutout"},
				faulted,
			},
			Faults: []Fault{
				{Code: "OVERTEMPERATURE", Name: "Overtemperature trip", Severity: Critical, Latching: true},
				{Code: "ELEMENT_FAILURE", Name: "Element failure", Severity: Warning, Latching: false, Silent: true},
			},
			Links: []Link{
				{Role: "contactor", Accepts: []string{"RELAY"}, Meaning: "the relay or contactor that switches the element; without one, the on command energizes it"},
				{Role: "controller", Accepts: []string{"PID_CONTROLLER"}, Meaning: "the controller whose output is the power share; the element is energized while it is enabled, and the PLC's on and power are ignored"},
			},
			Parameters: mustJSON(defaultHeaterParams()),
			ParameterSchema: []ParameterSpec{
				ratingParam("ratedPowerKw", "Rated power", 5, "kW", ""),
				{Key: "ambientC", Label: "Ambient temperature", Kind: "NUMBER", Role: "RATING", Unit: "°C", Default: 20.0, Min: f64(-100), Max: f64(500), MinInclusive: true, MaxInclusive: true, Description: "Temperature the element rests at when off."},
				{Key: "riseAtFullPowerC", Label: "Rise at full power", Kind: "NUMBER", Role: "RATING", Unit: "K", Default: 100.0, Min: f64(0), Max: f64(2000), MaxInclusive: true, Description: "Steady-state rise above ambient at full power."},
				secondsParam("timeConstantS", "Thermal time constant", 300, "First-order time constant of heating and cooling."),
				{Key: "maxTemperatureC", Label: "Cutout temperature", Kind: "NUMBER", Role: "LIMIT", Unit: "°C", Default: 250.0, Min: f64(-100), Max: f64(2000), MinInclusive: true, MaxInclusive: true, Description: "The thermostat removes power above it."},
				{Key: "cutoutHysteresisC", Label: "Cutout hysteresis", Kind: "NUMBER", Role: "LIMIT", Unit: "K", Default: 10.0, Min: f64(0), Max: f64(100), MaxInclusive: true, Description: "Power returns once the element has cooled by this much."},
				{Key: "initialTemperatureC", Label: "Initial temperature", Kind: "NUMBER", Role: "INITIAL", Unit: "°C", Description: "Ambient when absent."},
			},
			States: []string{"OFF", "HEATING", "CUTOUT", "FAULTED"},
		}
	})
}

func (h *Heater) Profile() string { return "HEATER" }
func (h *Heater) Version() int    { return 1 }

func (h *Heater) Configure(raw json.RawMessage) error {
	params := defaultHeaterParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := positive("ratedPowerKw", params.RatedPowerKw); err != nil {
		return err
	}
	if err := within("ambientC", params.AmbientC, -100, 500); err != nil {
		return err
	}
	if err := positive("riseAtFullPowerC", params.RiseAtFullPowerC); err != nil {
		return err
	}
	if params.RiseAtFullPowerC > 2000 {
		return &ParamError{Name: "riseAtFullPowerC", Reason: "must be at most 2000 K"}
	}
	if err := seconds("timeConstantS", params.TimeConstantS); err != nil {
		return err
	}
	if err := within("maxTemperatureC", params.MaxTemperatureC, -100, 2000); err != nil {
		return err
	}
	if err := positive("cutoutHysteresisC", params.CutoutHysteresisC); err != nil {
		return err
	}
	if params.CutoutHysteresisC > 100 {
		return &ParamError{Name: "cutoutHysteresisC", Reason: "must be at most 100 K"}
	}
	if params.InitialTemperatureC != nil && !finite(*params.InitialTemperatureC) {
		return &ParamError{Name: "initialTemperatureC", Reason: "must be a finite number"}
	}
	h.params = params
	h.temperature = params.AmbientC
	if params.InitialTemperatureC != nil {
		h.temperature = *params.InitialTemperatureC
	}
	h.power, h.cutout = 0, false
	h.state = "OFF"
	return nil
}

func (h *Heater) Step(dt float64, ctx *Context) {
	p := h.params
	energized := false
	share := 1.0
	if ctx.Inputs.Has("power") {
		share = clamp(ctx.Inputs["power"], 0, 100) / 100
	}
	controller, controlled := peerBehavior[*Controller](ctx, "controller")
	if controlled {
		share = clamp(controller.share(), 0, 1)
	}
	if !ctx.Tripped {
		switch contactor, switched := peerBehavior[*Relay](ctx, "contactor"); {
		case switched:
			energized = contactor.Closed()
		case controlled:
			energized = controller.enabled
		default:
			energized = ctx.Inputs.On("on")
		}
	}
	// The thermostat cuts out above the maximum and returns after the hysteresis.
	if h.temperature >= p.MaxTemperatureC {
		h.cutout = true
	} else if h.temperature <= p.MaxTemperatureC-p.CutoutHysteresisC {
		h.cutout = false
	}
	h.power = 0
	if energized && !h.cutout && !ctx.ActiveFaults["ELEMENT_FAILURE"] {
		h.power = share
	}
	target := p.AmbientC + p.RiseAtFullPowerC*h.power
	h.temperature += (target - h.temperature) * (1 - math.Exp(-dt/p.TimeConstantS))
	switch {
	case ctx.Tripped:
		h.state = "FAULTED"
	case energized && h.cutout:
		h.state = "CUTOUT"
	case h.power > 0:
		h.state = "HEATING"
	default:
		h.state = "OFF"
	}
}

func (h *Heater) Outputs(ctx *Context) Values {
	return Values{
		"heating":     asFloat(h.power > 0),
		"temperature": h.temperature,
		"powerOutput": h.params.RatedPowerKw * h.power,
		"cutout":      asFloat(h.cutout),
		"faulted":     asFloat(reportsFault(ctx)),
	}
}

func (h *Heater) State() string { return h.state }

func (h *Heater) Internal() map[string]float64 {
	return map[string]float64{"temperature": h.temperature, "power": h.power, "cutout": asFloat(h.cutout)}
}
