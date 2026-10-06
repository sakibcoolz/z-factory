package engine

import (
	"fmt"
	"math"
	"sort"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/sim"
)

// Mode says where the value of a measured output comes from (Phase 08, TASK-801).
type Mode string

const (
	// ModeAuto: the model's calculated value.
	ModeAuto Mode = "AUTO"
	// ModeManual: a value a tester set, held until it is cleared.
	ModeManual Mode = "MANUAL_OVERRIDE"
	// ModeScenario: a value that follows a profile over simulated time.
	ModeScenario Mode = "SCENARIO"
)

// ProfileStep is one step of a STEPS profile: from AtS seconds after the start, Value.
type ProfileStep struct {
	AtS   float64 `json:"atS"`
	Value float64 `json:"value"`
}

// Profile is how a SCENARIO value moves over simulated time: a RAMP from one value to
// another over DurationS seconds (then held), or STEPS at given offsets.
type Profile struct {
	Kind      string        `json:"kind"`
	From      float64       `json:"from,omitempty"`
	To        float64       `json:"to,omitempty"`
	DurationS float64       `json:"durationS,omitempty"`
	Steps     []ProfileStep `json:"steps,omitempty"`
}

// OverrideRequest sets the mode of one measured output.
type OverrideRequest struct {
	Mode    Mode     `json:"mode"`
	Value   *float64 `json:"value,omitempty"`
	Profile *Profile `json:"profile,omitempty"`
	// Source names who asked, for the record: an operator, a test.
	Source string `json:"source,omitempty"`
}

// SignalState is one measured output as inspecting it shows: where its value comes from,
// what the model calculates and what is delivered.
type SignalState struct {
	Signal     string   `json:"signal"`
	Unit       string   `json:"unit"`
	Bool       bool     `json:"bool"`
	Min        float64  `json:"min"`
	Max        float64  `json:"max"`
	Mode       Mode     `json:"mode"`
	Calculated float64  `json:"calculated"`
	Effective  float64  `json:"effective"`
	Value      *float64 `json:"value,omitempty"`
	Profile    *Profile `json:"profile,omitempty"`
	SinceTick  uint64   `json:"sinceTick"`
	SinceTimeS float64  `json:"sinceTimeS"`
	Source     string   `json:"source,omitempty"`
}

type override struct {
	mode       Mode
	value      float64
	profile    *Profile
	sinceTick  uint64
	sinceTimeS float64
	source     string
}

// measured returns the model's measured outputs by name; a model without any has none.
func (i *Instance) measured() map[string]sim.Measured {
	out := map[string]sim.Measured{}
	if overridable, ok := i.model.(sim.Overridable); ok {
		for _, signal := range overridable.Measured() {
			out[signal.Name] = signal
		}
	}
	return out
}

func inRange(signal sim.Measured, value float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return &ConfigError{fmt.Sprintf("%s needs a number", signal.Name)}
	}
	if signal.Bool && value != 0 && value != 1 {
		return &ConfigError{fmt.Sprintf("%s is on/off: use 0 or 1", signal.Name)}
	}
	if value < signal.Min || value > signal.Max {
		return &ConfigError{fmt.Sprintf("%s takes %g to %g %s", signal.Name, signal.Min, signal.Max, signal.Unit)}
	}
	return nil
}

func checkProfile(signal sim.Measured, profile *Profile) error {
	if profile == nil {
		return &ConfigError{"a SCENARIO needs a profile"}
	}
	switch profile.Kind {
	case "RAMP":
		if profile.DurationS <= 0 || profile.DurationS > 86_400 {
			return &ConfigError{"a RAMP needs durationS between 0 and 86400"}
		}
		if err := inRange(signal, profile.From); err != nil {
			return err
		}
		return inRange(signal, profile.To)
	case "STEPS":
		if len(profile.Steps) == 0 || len(profile.Steps) > 100 {
			return &ConfigError{"STEPS takes 1 to 100 steps"}
		}
		if profile.Steps[0].AtS != 0 {
			return &ConfigError{"the first step is at 0 s"}
		}
		for index, step := range profile.Steps {
			if index > 0 && step.AtS <= profile.Steps[index-1].AtS {
				return &ConfigError{"steps are in increasing time"}
			}
			if err := inRange(signal, step.Value); err != nil {
				return err
			}
		}
		return nil
	default:
		return &ConfigError{`a profile is a "RAMP" or "STEPS"`}
	}
}

// valueAt is the override's value at simulated time timeS.
func (o *override) valueAt(signal sim.Measured, timeS float64) float64 {
	if o.mode == ModeManual {
		return o.value
	}
	elapsed := timeS - o.sinceTimeS
	var value float64
	switch o.profile.Kind {
	case "RAMP":
		share := math.Min(math.Max(elapsed/o.profile.DurationS, 0), 1)
		value = o.profile.From + (o.profile.To-o.profile.From)*share
	default:
		value = o.profile.Steps[0].Value
		for _, step := range o.profile.Steps {
			if step.AtS <= elapsed {
				value = step.Value
			}
		}
	}
	if signal.Bool {
		if value >= 0.5 {
			return 1
		}
		return 0
	}
	return math.Round(value*1e6) / 1e6
}

// applyLocked derives the delivered outputs from the calculated ones.
func (i *Instance) applyLocked() {
	outputs := copyValues(i.calculated)
	measured := i.measured()
	for name, override := range i.overrides {
		outputs[name] = override.valueAt(measured[name], i.timeS())
	}
	i.outputs = outputs
}

func (i *Instance) signalStatesLocked(onlyOverridden bool) []SignalState {
	measured := i.measured()
	names := make([]string, 0, len(measured))
	for name := range measured {
		names = append(names, name)
	}
	sort.Strings(names)
	states := []SignalState{}
	for _, name := range names {
		signal := measured[name]
		override, overridden := i.overrides[name]
		if onlyOverridden && !overridden {
			continue
		}
		state := SignalState{
			Signal:     name,
			Unit:       signal.Unit,
			Bool:       signal.Bool,
			Min:        signal.Min,
			Max:        signal.Max,
			Mode:       ModeAuto,
			Calculated: i.calculated[name],
			Effective:  i.outputs[name],
		}
		if overridden {
			state.Mode = override.mode
			state.SinceTick = override.sinceTick
			state.SinceTimeS = override.sinceTimeS
			state.Source = override.source
			if override.mode == ModeManual {
				value := override.value
				state.Value = &value
			} else {
				state.Profile = override.profile
			}
		}
		states = append(states, state)
	}
	return states
}

// Overrides lists every measured output of the instance with its mode and values.
func (e *Engine) Overrides(id string) ([]SignalState, error) {
	instance, err := e.Get(id)
	if err != nil {
		return nil, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	return instance.signalStatesLocked(false), nil
}

// SetOverride replaces where a measured output's value comes from. Only measured outputs
// can be overridden: never a command the PLC gives, an actuator's state or the model's own
// alarm. AUTO is the same as clearing. The override is test state of the running
// instance: it survives ticks, stop and start, and goes with a reset or a reload.
func (e *Engine) SetOverride(id string, signalName string, request OverrideRequest) (SignalState, error) {
	instance, err := e.Get(id)
	if err != nil {
		return SignalState{}, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	signal, ok := instance.measured()[signalName]
	if !ok {
		for _, input := range instance.model.Inputs() {
			if input == signalName {
				return SignalState{}, &ConfigError{fmt.Sprintf("%s is a command the PLC gives; only measured values can be overridden", signalName)}
			}
		}
		for _, output := range instance.model.Outputs() {
			if output == signalName {
				return SignalState{}, &ConfigError{fmt.Sprintf("%s is not a measured value of %s; only measured values can be overridden", signalName, instance.model.Type())}
			}
		}
		return SignalState{}, ErrNotFound
	}
	if len(request.Source) > 120 {
		return SignalState{}, &ConfigError{"source is at most 120 characters"}
	}
	next := &override{mode: request.Mode, sinceTick: instance.tick, sinceTimeS: instance.timeS(), source: request.Source}
	switch request.Mode {
	case ModeAuto:
		instance.clearLocked(signalName, request.Source)
		return instance.stateOf(signalName), nil
	case ModeManual:
		if request.Value == nil || request.Profile != nil {
			return SignalState{}, &ConfigError{"MANUAL_OVERRIDE takes a value and no profile"}
		}
		if err := inRange(signal, *request.Value); err != nil {
			return SignalState{}, err
		}
		next.value = *request.Value
	case ModeScenario:
		if request.Value != nil {
			return SignalState{}, &ConfigError{"SCENARIO takes a profile and no value"}
		}
		if err := checkProfile(signal, request.Profile); err != nil {
			return SignalState{}, err
		}
		profile := *request.Profile
		profile.Steps = append([]ProfileStep(nil), request.Profile.Steps...)
		next.profile = &profile
	default:
		return SignalState{}, &ConfigError{`mode is "AUTO", "MANUAL_OVERRIDE" or "SCENARIO"`}
	}
	instance.overrides[signalName] = next
	instance.applyLocked()
	values := map[string]float64{"effective": instance.outputs[signalName], "calculated": instance.calculated[signalName]}
	instance.record(sim.Event{Type: "OVERRIDE_SET", Message: fmt.Sprintf("%s set to %s%s", signalName, request.Mode, sourceSuffix(request.Source)), Values: values})
	return instance.stateOf(signalName), nil
}

// ClearOverride returns a measured output to AUTO. Clearing one that is not overridden
// changes nothing and is not an error.
func (e *Engine) ClearOverride(id string, signalName string, source string) (SignalState, error) {
	instance, err := e.Get(id)
	if err != nil {
		return SignalState{}, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	if _, ok := instance.measured()[signalName]; !ok {
		return SignalState{}, ErrNotFound
	}
	if len(source) > 120 {
		source = source[:120]
	}
	instance.clearLocked(signalName, source)
	return instance.stateOf(signalName), nil
}

func (i *Instance) clearLocked(signalName string, source string) {
	if _, overridden := i.overrides[signalName]; !overridden {
		return
	}
	delete(i.overrides, signalName)
	i.applyLocked()
	i.record(sim.Event{Type: "OVERRIDE_CLEARED", Message: fmt.Sprintf("%s back to AUTO%s", signalName, sourceSuffix(source))})
}

func (i *Instance) stateOf(signalName string) SignalState {
	for _, state := range i.signalStatesLocked(false) {
		if state.Signal == signalName {
			return state
		}
	}
	return SignalState{Signal: signalName, Mode: ModeAuto}
}

func sourceSuffix(source string) string {
	if source == "" {
		return ""
	}
	return " by " + source
}
