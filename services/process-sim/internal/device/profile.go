// Package device holds the catalog device runtime's behaviour profiles and the factory
// simulation that couples them (TASK-1009). A profile is the documented, generic
// behaviour of one device category: a drive, a motor, a pump, a valve, a transmitter, a
// switch. It is a deterministic function of its parameters, its state, its inputs, the
// devices it is coupled to and a fixed time step; it uses no clock and no randomness
// beyond a seeded generator. It computes the device's response to what the PLC commands
// and never decides a command itself (ADR-0008, ADR-0015).
//
// Nothing here is a vendor's firmware. The profiles are the generic approximations of
// docs/device-simulation.md, ported from the server's TypeScript simulator so the two
// agree value for value.
package device

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
)

// ContractVersion is the version of the device configuration contract the runtime accepts.
const ContractVersion = 1

// Direction of a signal: IN, the PLC drives it; OUT, the device produces it for the PLC.
type Direction string

const (
	In  Direction = "IN"
	Out Direction = "OUT"
)

// Kind of a signal's value. A BOOL travels as 0 or 1.
type Kind string

const (
	Bool   Kind = "BOOL"
	Number Kind = "NUMBER"
)

// Signal is one value a device exchanges with the PLC.
type Signal struct {
	Key       string    `json:"key"`
	Direction Direction `json:"direction"`
	Kind      Kind      `json:"kind"`
	Label     string    `json:"label"`
	Unit      string    `json:"unit,omitempty"`
}

// Severity of a fault or an event.
type Severity string

const (
	Info     Severity = "INFO"
	Warning  Severity = "WARNING"
	Critical Severity = "CRITICAL"
)

// Fault is one fault condition a profile supports.
type Fault struct {
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	Severity Severity `json:"severity"`
	// A latching fault trips the device: it stays faulted after the cause is cleared, until reset.
	Latching bool `json:"latching"`
	// The device does not report it on its own fault output; PLC logic has to detect it.
	Silent bool `json:"silent,omitempty"`
}

// Link is a coupling a profile may have to another device, by role.
type Link struct {
	Role string `json:"role"`
	// Profiles the linked device may have; empty accepts any profile that is not a
	// sensor or a switch.
	Accepts []string `json:"accepts,omitempty"`
	// What the link means, for people and agents.
	Meaning string `json:"meaning"`
}

// ParameterSpec describes one parameter of a profile (TASK-1010): its kind (NUMBER,
// CHOICE or STRUCTURED), what it is for (RATING, TIMING, LIMIT, INITIAL, SOURCE, SHAPE,
// EVENT), its unit, its generic default and its bounds. Configure enforces exactly what
// the spec says; the behaviour contract on the server (lib/domain/behavior-contract.ts)
// states the same and the parity test compares the two.
type ParameterSpec struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
	Role  string `json:"role"`
	Unit  string `json:"unit,omitempty"`
	// The generic default; absent for an optional parameter the behaviour derives.
	Default      any      `json:"default,omitempty"`
	Min          *float64 `json:"min,omitempty"`
	Max          *float64 `json:"max,omitempty"`
	MinInclusive bool     `json:"minInclusive,omitempty"`
	MaxInclusive bool     `json:"maxInclusive,omitempty"`
	// CHOICE: the allowed values.
	Choices []string `json:"choices,omitempty"`
	// STRUCTURED: the kinds the structure may take, each with its fields.
	Kinds       map[string][]string `json:"kinds,omitempty"`
	Description string              `json:"description,omitempty"`
}

// Description is what a profile declares about itself: the stable contract Z-Factory,
// the catalog (TASK-1010) and the coverage report (TASK-1016) read.
type Description struct {
	Key     string `json:"key"`
	Version int    `json:"version"`
	// What the profile models, in one sentence, and what it does not.
	Summary string   `json:"summary"`
	Signals []Signal `json:"signals"`
	Faults  []Fault  `json:"faults"`
	Links   []Link   `json:"links,omitempty"`
	// The generic defaults, as a parameter body Configure accepts.
	Parameters json.RawMessage `json:"parameters"`
	// The machine-readable schema of the parameters (TASK-1010).
	ParameterSchema []ParameterSpec `json:"parameterSchema"`
	States          []string        `json:"states"`
	Forcible        bool            `json:"forcible"`
	ForcedKind      Kind            `json:"forcedKind,omitempty"`
}

func f64(value float64) *float64 { return &value }

// ratingParam is a positive rating with no upper bound.
func ratingParam(key, label string, def float64, unit, description string) ParameterSpec {
	return ParameterSpec{Key: key, Label: label, Kind: "NUMBER", Role: "RATING", Unit: unit, Default: def, Min: f64(0), Description: description}
}

// secondsParam is a duration: above zero, at most an hour.
func secondsParam(key, label string, def float64, description string) ParameterSpec {
	return ParameterSpec{Key: key, Label: label, Kind: "NUMBER", Role: "TIMING", Unit: "s", Default: def, Min: f64(0), Max: f64(3600), MaxInclusive: true, Description: description}
}

// Values are a device's inputs or outputs by signal key. A BOOL is 0 or 1.
type Values map[string]float64

// On reads a value as a switch: anything above a half is on.
func (v Values) On(key string) bool { return v[key] > 0.5 }

// Has says whether a signal is wired at all: an input that is absent is not driven.
func (v Values) Has(key string) bool {
	_, ok := v[key]
	return ok
}

func asFloat(on bool) float64 {
	if on {
		return 1
	}
	return 0
}

// Behavior is one device's behaviour: the profile instantiated with its parameters.
// The factory simulation owns the common fault, trip and link state; a behaviour holds
// only what its physics needs.
type Behavior interface {
	Profile() string
	Version() int
	// Configure validates the parameters (unknown fields and bad values are refused) and
	// sets the initial state.
	Configure(parameters json.RawMessage) error
	// Step advances the physics by dt seconds. The device's inputs, trip and active
	// faults are read from ctx; the linked devices through ctx.Peer.
	Step(dt float64, ctx *Context)
	// Outputs are what the PLC reads after a step.
	Outputs(ctx *Context) Values
	// State names the behaviour's state for events and snapshots: STOPPED, RUNNING, OPEN …
	State() string
	// Internal numbers for inspection and tests.
	Internal() map[string]float64
}

// Load is motor-driven equipment: the shaft torque it asks for at a speed fraction, as a
// share of rated torque. The motor reads it.
type Load interface {
	Torque(ctx *Context, speedFraction float64) float64
}

// Supply is a device that feeds a motor (the motor's "drive" link): a drive gives a
// frequency, a relay, contactor or starter the line frequency, a starter may also limit
// the speed while it ramps.
type Supply interface {
	Supply(ctx *Context) SupplyState
}

// SupplyState is what a motor draws from its supply in a step.
type SupplyState struct {
	// Whether the motor is energized at all.
	Energized bool
	// Supply frequency, signed (negative is reverse); ignored when Line is set.
	FrequencyHz float64
	// The line frequency (the motor's rated frequency) instead of FrequencyHz.
	Line bool
	// A share of rated speed the supply allows while it ramps; 0 means no limit.
	SpeedLimit float64
}

// Forcible behaviours (transmitters, switches) can have their value forced by a tester.
type Forcible interface {
	ForcedKind() Kind
}

// Context is what a behaviour sees of its device and its peers during a step.
type Context struct {
	Inputs       Values
	Tripped      bool
	ActiveFaults map[string]bool
	// ElapsedS is the factory's simulated time since the start.
	ElapsedS float64
	// Forced value of a forcible device, or nil.
	Forced *float64
	peers  map[string]*Device
	faults map[string]Fault
}

// reportsFault is what the device reports on its own fault output: a trip, or an active
// fault it can detect itself (a silent one, like a stuck valve, it cannot).
func reportsFault(ctx *Context) bool {
	if ctx.Tripped {
		return true
	}
	for code := range ctx.ActiveFaults {
		if !ctx.faults[code].Silent {
			return true
		}
	}
	return false
}

// Peer returns the device linked under the role, or nil.
func (c *Context) Peer(role string) *Device {
	if c.peers == nil {
		return nil
	}
	return c.peers[role]
}

// Factory builds a fresh, unconfigured behaviour.
type Factory func() Behavior

type registration struct {
	factory  Factory
	describe func() Description
}

var (
	mu       sync.RWMutex
	registry = map[string]registration{}
)

// Register makes a profile available by key. Called from init functions.
func Register(key string, factory Factory, describe func() Description) {
	mu.Lock()
	defer mu.Unlock()
	if _, taken := registry[key]; taken {
		panic(fmt.Sprintf("device: profile %s registered twice", key))
	}
	registry[key] = registration{factory: factory, describe: describe}
}

// New returns a fresh behaviour of the profile, or an error naming the profiles that exist.
func New(key string) (Behavior, error) {
	mu.RLock()
	reg, ok := registry[key]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown profile %q; known: %v", key, Profiles())
	}
	return reg.factory(), nil
}

// Describe returns a profile's description.
func Describe(key string) (Description, error) {
	mu.RLock()
	reg, ok := registry[key]
	mu.RUnlock()
	if !ok {
		return Description{}, fmt.Errorf("unknown profile %q; known: %v", key, Profiles())
	}
	return reg.describe(), nil
}

// Profiles lists the registered profile keys, sorted.
func Profiles() []string {
	mu.RLock()
	defer mu.RUnlock()
	keys := make([]string, 0, len(registry))
	for key := range registry {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// ParamError says which parameter is wrong and why.
type ParamError struct {
	Name   string
	Reason string
}

func (e *ParamError) Error() string {
	if e.Name == "" {
		return "parameters " + e.Reason
	}
	return fmt.Sprintf("parameter %s %s", e.Name, e.Reason)
}

// decodeParams fills a parameter struct that already carries its defaults from JSON,
// refusing fields the profile does not have. An absent or null body keeps the defaults.
func decodeParams(raw json.RawMessage, into any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		var unmarshalErr *json.UnmarshalTypeError
		if errors.As(err, &unmarshalErr) {
			return &ParamError{Name: unmarshalErr.Field, Reason: "has the wrong type"}
		}
		return &ParamError{Reason: "are not valid: " + err.Error()}
	}
	return nil
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func positive(name string, value float64) error {
	if !finite(value) || value <= 0 {
		return &ParamError{Name: name, Reason: "must be greater than zero"}
	}
	return nil
}

func seconds(name string, value float64) error {
	if err := positive(name, value); err != nil {
		return err
	}
	if value > 3600 {
		return &ParamError{Name: name, Reason: "must be at most 3600 seconds"}
	}
	return nil
}

func within(name string, value, lo, hi float64) error {
	if !finite(value) || value < lo || value > hi {
		return &ParamError{Name: name, Reason: fmt.Sprintf("must be between %g and %g", lo, hi)}
	}
	return nil
}

func clamp(value, lo, hi float64) float64 {
	if value < lo {
		return lo
	}
	if value > hi {
		return hi
	}
	return value
}

// approach moves current towards target by at most maxDelta.
func approach(current, target, maxDelta float64) float64 {
	delta := target - current
	if math.Abs(delta) <= maxDelta {
		return target
	}
	if delta < 0 {
		return current - maxDelta
	}
	return current + maxDelta
}

// standstill is the share of rated speed below which a shaft counts as standing still.
const standstill = 0.01

// mulberry32 is the small seeded generator the server's simulator uses, so a RANDOM
// source gives the same samples here as there.
type mulberry32 struct{ state uint32 }

func (g *mulberry32) next() float64 {
	g.state += 0x6d2b79f5
	t := g.state
	t = imul(t^(t>>15), t|1)
	t ^= t + imul(t^(t>>7), t|61)
	return float64((t^(t>>14))>>0) / 4294967296
}

// imul is JavaScript's Math.imul: the low 32 bits of the product.
func imul(a, b uint32) uint32 { return uint32(uint64(a) * uint64(b)) }

// mustJSON marshals a parameter default set for a description.
func mustJSON(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}
