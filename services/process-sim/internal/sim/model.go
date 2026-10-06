// Package sim holds the process models the service can run and the contract they share.
//
// A model is a deterministic function of its parameters, its state, its inputs and a
// fixed time step: the same configuration stepped the same number of times with the same
// inputs gives the same outputs, on any machine. Models use no clock and no randomness.
// They compute the process response to what the PLC commands; they never decide a
// command themselves (ADR-0008).
package sim

import (
	"fmt"
	"sort"
	"sync"
)

// Event is something a model found worth recording during a step: a start, a stop, an
// alarm coming or going. The engine numbers it and stamps it with the tick.
type Event struct {
	Type    string             `json:"type"`
	Message string             `json:"message"`
	Values  map[string]float64 `json:"values,omitempty"`
}

// Model is one process model. Reset validates the parameters and sets the initial state;
// Step advances the state by dt seconds under the given inputs and returns the outputs.
type Model interface {
	// Type is the stable name Z-Factory refers to, e.g. PUMP_HOUSE.
	Type() string
	// Version of the model's equations; a changed model is a new version.
	Version() int
	// Inputs the model reads, in a fixed order. Missing inputs are zero.
	Inputs() []string
	// Outputs the model writes, in a fixed order.
	Outputs() []string
	// Parameters the model takes, with their defaults.
	Parameters() map[string]float64
	Reset(params map[string]float64) error
	Step(dt float64, inputs map[string]float64) (outputs map[string]float64, events []Event)
	// State is the internal state, for inspection and tests.
	State() map[string]float64
}

// Factory builds a fresh, unreset model.
type Factory func() Model

var (
	mu       sync.RWMutex
	registry = map[string]Factory{}
)

// Register makes a model type available by name. Called from init functions.
func Register(name string, factory Factory) {
	mu.Lock()
	defer mu.Unlock()
	if _, taken := registry[name]; taken {
		panic(fmt.Sprintf("sim: model %s registered twice", name))
	}
	registry[name] = factory
}

// New returns a fresh model of the type, or an error naming the types that exist.
func New(name string) (Model, error) {
	mu.RLock()
	factory, ok := registry[name]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown model type %q; known: %v", name, Types())
	}
	return factory(), nil
}

// Types lists the registered model types, sorted.
func Types() []string {
	mu.RLock()
	defer mu.RUnlock()
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ParamError says which parameter is wrong and why.
type ParamError struct {
	Name   string
	Reason string
}

func (e *ParamError) Error() string { return fmt.Sprintf("parameter %s %s", e.Name, e.Reason) }

// resolve fills the defaults, refuses unknown parameters and checks that every value is finite and positive where required.
func resolve(defaults map[string]float64, given map[string]float64, positive ...string) (map[string]float64, error) {
	params := make(map[string]float64, len(defaults))
	for key, value := range defaults {
		params[key] = value
	}
	for key, value := range given {
		if _, known := defaults[key]; !known {
			return nil, &ParamError{Name: key, Reason: "is not a parameter of this model"}
		}
		if value != value || value > 1e300 || value < -1e300 {
			return nil, &ParamError{Name: key, Reason: "must be a finite number"}
		}
		params[key] = value
	}
	for _, key := range positive {
		if params[key] <= 0 {
			return nil, &ParamError{Name: key, Reason: "must be greater than zero"}
		}
	}
	return params, nil
}

// clamp keeps a value inside [lo, hi].
func clamp(value, lo, hi float64) float64 {
	if value < lo {
		return lo
	}
	if value > hi {
		return hi
	}
	return value
}

// boolean reads an input as a switch: anything above a half is on.
func boolean(inputs map[string]float64, key string) bool { return inputs[key] > 0.5 }

func asFloat(on bool) float64 {
	if on {
		return 1
	}
	return 0
}

// towards moves a value linearly towards a target by at most rate*dt.
func towards(value, target, rate, dt float64) float64 {
	step := rate * dt
	switch {
	case value < target-step:
		return value + step
	case value > target+step:
		return value - step
	default:
		return target
	}
}

// Measured is one output of a model that stands for a measurement the PLC reads — a
// process value or a switch — and that a test may therefore replace (Phase 08,
// TASK-801). Commands, actuator states and the model's own alarms are never measured
// values: they are what the PLC or the model decides.
type Measured struct {
	Name string  `json:"name"`
	Unit string  `json:"unit"`
	Bool bool    `json:"bool"`
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
}

// Overridable is implemented by models with measured outputs. The ranges follow the
// parameters the model was last reset with.
type Overridable interface {
	Measured() []Measured
}
