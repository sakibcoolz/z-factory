package device

import (
	"encoding/json"
	"math"
)

// Indicator is a stack light, lamp or buzzer: each lamp and the buzzer follow their
// command; with the flash command on, the lamps that are commanded flash at the flash
// rate. A failed lamp set lights nothing and reports nothing. Approximation: lamps are
// on or off, the buzzer has one tone; no brightness, no lamp test input.
type Indicator struct {
	params indicatorParams
	lit    map[string]bool
	buzzer bool
	state  string
}

type indicatorParams struct {
	// Flashes per second while the flash command is on.
	FlashRateHz float64 `json:"flashRateHz"`
}

func defaultIndicatorParams() indicatorParams { return indicatorParams{FlashRateHz: 1} }

var lampKeys = []string{"red", "amber", "green", "blue"}

func init() {
	Register("INDICATOR", func() Behavior { return &Indicator{} }, func() Description {
		return Description{
			Key:     "INDICATOR",
			Version: 1,
			Summary: "A stack light, lamp or buzzer: each lamp and the buzzer follow their command, the commanded lamps flash at the flash rate while the flash command is on, and a failed lamp set lights nothing.",
			Signals: []Signal{
				{Key: "red", Direction: In, Kind: Bool, Label: "Red lamp command"},
				{Key: "amber", Direction: In, Kind: Bool, Label: "Amber lamp command"},
				{Key: "green", Direction: In, Kind: Bool, Label: "Green lamp command"},
				{Key: "blue", Direction: In, Kind: Bool, Label: "Blue lamp command"},
				{Key: "buzzer", Direction: In, Kind: Bool, Label: "Buzzer command"},
				{Key: "flash", Direction: In, Kind: Bool, Label: "Flash the commanded lamps"},
				{Key: "redLit", Direction: Out, Kind: Bool, Label: "Red lamp lit"},
				{Key: "amberLit", Direction: Out, Kind: Bool, Label: "Amber lamp lit"},
				{Key: "greenLit", Direction: Out, Kind: Bool, Label: "Green lamp lit"},
				{Key: "blueLit", Direction: Out, Kind: Bool, Label: "Blue lamp lit"},
				{Key: "buzzerOn", Direction: Out, Kind: Bool, Label: "Buzzer sounding"},
			},
			Faults: []Fault{
				{Code: "LAMP_FAILURE", Name: "Lamp failure", Severity: Warning, Latching: false, Silent: true},
			},
			Parameters: mustJSON(defaultIndicatorParams()),
			ParameterSchema: []ParameterSpec{
				{Key: "flashRateHz", Label: "Flash rate", Kind: "NUMBER", Role: "TIMING", Unit: "Hz", Default: 1.0, Min: f64(0), Max: f64(10), MaxInclusive: true, Description: "Flashes per second while the flash command is on."},
			},
			States: []string{"OFF", "ON", "FLASHING"},
		}
	})
}

func (i *Indicator) Profile() string { return "INDICATOR" }
func (i *Indicator) Version() int    { return 1 }

func (i *Indicator) Configure(raw json.RawMessage) error {
	params := defaultIndicatorParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := positive("flashRateHz", params.FlashRateHz); err != nil {
		return err
	}
	if params.FlashRateHz > 10 {
		return &ParamError{Name: "flashRateHz", Reason: "must be at most 10 Hz"}
	}
	i.params = params
	i.lit = map[string]bool{}
	i.buzzer = false
	i.state = "OFF"
	return nil
}

func (i *Indicator) Step(_ float64, ctx *Context) {
	flash := ctx.Inputs.On("flash")
	// The first half of every flash period is lit.
	phaseLit := math.Mod(ctx.ElapsedS*i.params.FlashRateHz, 1) < 0.5
	any := false
	for _, key := range lampKeys {
		commanded := ctx.Inputs.On(key) && !ctx.ActiveFaults["LAMP_FAILURE"]
		i.lit[key] = commanded && (!flash || phaseLit)
		any = any || commanded
	}
	i.buzzer = ctx.Inputs.On("buzzer")
	switch {
	case any && flash:
		i.state = "FLASHING"
	case any || i.buzzer:
		i.state = "ON"
	default:
		i.state = "OFF"
	}
}

func (i *Indicator) Outputs(_ *Context) Values {
	values := Values{"buzzerOn": asFloat(i.buzzer)}
	for _, key := range lampKeys {
		values[key+"Lit"] = asFloat(i.lit[key])
	}
	return values
}

func (i *Indicator) State() string { return i.state }

func (i *Indicator) Internal() map[string]float64 {
	internal := map[string]float64{"buzzer": asFloat(i.buzzer)}
	for _, key := range lampKeys {
		internal[key] = asFloat(i.lit[key])
	}
	return internal
}
