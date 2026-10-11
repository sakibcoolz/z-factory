package device

import "encoding/json"

// Pump is a centrifugal pump on a motor (link "motor"): flow proportional to speed and
// discharge pressure to speed squared, the affinity laws against a fixed system. Running
// dry removes flow and pressure and unloads the motor.
type Pump struct {
	params        pumpParams
	speedFraction float64
	state         string
}

type pumpParams struct {
	// Flow at rated speed, in the engineering unit of the tag it is mapped to.
	RatedFlow float64 `json:"ratedFlow"`
	// Discharge pressure at rated speed.
	RatedPressure float64 `json:"ratedPressure"`
}

func defaultPumpParams() pumpParams { return pumpParams{RatedFlow: 100, RatedPressure: 4} }

var loadLinks = []Link{{Role: "motor", Accepts: []string{"MOTOR"}, Meaning: "the motor on the shaft; one motor drives one load"}}

func init() {
	Register("PUMP", func() Behavior { return &Pump{} }, func() Description {
		return Description{
			Key:     "PUMP",
			Version: 1,
			Summary: "A centrifugal pump on a motor: flow proportional to speed, pressure to speed squared; dry running removes both and unloads the motor.",
			Signals: []Signal{
				running,
				faulted,
				{Key: "flow", Direction: Out, Kind: Number, Label: "Flow"},
				{Key: "pressure", Direction: Out, Kind: Number, Label: "Discharge pressure"},
			},
			Faults:     []Fault{{Code: "DRY_RUN", Name: "Dry running", Severity: Warning, Latching: false}},
			Links:      loadLinks,
			Parameters: mustJSON(defaultPumpParams()),
			States:     []string{"STOPPED", "RUNNING", "DRY_RUN"},
		}
	})
	for _, kind := range []string{"FAN", "CONVEYOR", "MIXER", "COMPRESSOR"} {
		kind := kind
		Register(kind, func() Behavior { return &GenericLoad{kind: kind} }, func() Description {
			profile := "CONSTANT"
			if kind == "FAN" {
				profile = "QUADRATIC"
			}
			return Description{
				Key:     kind,
				Version: 1,
				Summary: "Motor-driven equipment whose output follows the speed of its motor; shaft torque " + map[string]string{"QUADRATIC": "grows with the square of the speed", "CONSTANT": "is constant once it moves"}[profile] + " unless the parameters say otherwise.",
				Signals: []Signal{
					running,
					faulted,
					{Key: "output", Direction: Out, Kind: Number, Label: "Output"},
				},
				Faults:     []Fault{},
				Links:      loadLinks,
				Parameters: mustJSON(map[string]any{"ratedOutput": 100, "loadProfile": profile}),
				States:     []string{"STOPPED", "RUNNING"},
			}
		})
	}
}

func (p *Pump) Profile() string { return "PUMP" }
func (p *Pump) Version() int    { return 1 }

func (p *Pump) Configure(raw json.RawMessage) error {
	params := defaultPumpParams()
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	for name, value := range map[string]float64{"ratedFlow": params.RatedFlow, "ratedPressure": params.RatedPressure} {
		if err := positive(name, value); err != nil {
			return err
		}
	}
	p.params = params
	p.speedFraction = 0
	p.state = "STOPPED"
	return nil
}

func (p *Pump) Step(_ float64, ctx *Context) {
	p.speedFraction = shaftSpeed(ctx)
	switch {
	case ctx.ActiveFaults["DRY_RUN"]:
		p.state = "DRY_RUN"
	case p.speedFraction > standstill:
		p.state = "RUNNING"
	default:
		p.state = "STOPPED"
	}
}

func (p *Pump) Outputs(ctx *Context) Values {
	n := p.speedFraction
	flow, pressure := p.params.RatedFlow*n, p.params.RatedPressure*n*n
	if ctx.ActiveFaults["DRY_RUN"] {
		flow, pressure = 0, 0
	}
	return Values{"running": asFloat(n > standstill), "faulted": asFloat(reportsFault(ctx)), "flow": flow, "pressure": pressure}
}

func (p *Pump) State() string { return p.state }

func (p *Pump) Internal() map[string]float64 {
	return map[string]float64{"speedFraction": p.speedFraction}
}

// Torque of a pump: quadratic with speed; a fifth of it when running dry.
func (p *Pump) Torque(ctx *Context, n float64) float64 {
	if ctx.ActiveFaults["DRY_RUN"] {
		return 0.2 * n * n
	}
	return n * n
}

// GenericLoad is a fan, conveyor, mixer or compressor: output proportional to the motor's speed.
type GenericLoad struct {
	kind          string
	params        loadParams
	speedFraction float64
	state         string
}

type loadParams struct {
	// Output at rated speed (airflow, belt speed, …).
	RatedOutput float64 `json:"ratedOutput"`
	// How shaft torque grows with speed: QUADRATIC (fans) or CONSTANT.
	LoadProfile string `json:"loadProfile"`
}

func (g *GenericLoad) Profile() string { return g.kind }
func (g *GenericLoad) Version() int    { return 1 }

func (g *GenericLoad) Configure(raw json.RawMessage) error {
	params := loadParams{RatedOutput: 100}
	if err := decodeParams(raw, &params); err != nil {
		return err
	}
	if err := positive("ratedOutput", params.RatedOutput); err != nil {
		return err
	}
	switch params.LoadProfile {
	case "":
		params.LoadProfile = "CONSTANT"
		if g.kind == "FAN" {
			params.LoadProfile = "QUADRATIC"
		}
	case "QUADRATIC", "CONSTANT":
	default:
		return &ParamError{Name: "loadProfile", Reason: `must be "QUADRATIC" or "CONSTANT"`}
	}
	g.params = params
	g.speedFraction = 0
	g.state = "STOPPED"
	return nil
}

func (g *GenericLoad) Step(_ float64, ctx *Context) {
	g.speedFraction = shaftSpeed(ctx)
	if g.speedFraction > standstill {
		g.state = "RUNNING"
	} else {
		g.state = "STOPPED"
	}
}

func (g *GenericLoad) Outputs(ctx *Context) Values {
	return Values{
		"running": asFloat(g.speedFraction > standstill),
		"faulted": asFloat(reportsFault(ctx)),
		"output":  g.params.RatedOutput * g.speedFraction,
	}
}

func (g *GenericLoad) State() string { return g.state }

func (g *GenericLoad) Internal() map[string]float64 {
	return map[string]float64{"speedFraction": g.speedFraction}
}

// Torque of generic equipment: with the square of speed, or constant once it moves.
func (g *GenericLoad) Torque(_ *Context, n float64) float64 {
	if g.params.LoadProfile == "QUADRATIC" {
		return n * n
	}
	if n > standstill {
		return 1
	}
	return 0
}

// shaftSpeed is the speed fraction of the motor linked under "motor", or zero without one.
func shaftSpeed(ctx *Context) float64 {
	if motor, ok := peerBehavior[*Motor](ctx, "motor"); ok {
		return motor.speedFraction()
	}
	return 0
}
