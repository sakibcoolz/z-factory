package device

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

// FaultOverride is what a catalog model may change about a generic fault of its profile.
type FaultOverride struct {
	Severity *Severity `json:"severity,omitempty"`
	Latching *bool     `json:"latching,omitempty"`
}

// Config is one device as Z-Factory configures it: its profile from the catalog's
// simulation metadata, its parameters, the catalog's fault overrides and its links to
// other devices of the factory by role.
type Config struct {
	DeviceID       string                   `json:"deviceId"`
	Name           string                   `json:"name"`
	Profile        string                   `json:"profile"`
	ProfileVersion int                      `json:"profileVersion"`
	Parameters     json.RawMessage          `json:"parameters,omitempty"`
	Faults         map[string]FaultOverride `json:"faults,omitempty"`
	Links          map[string]string        `json:"links,omitempty"`
	Inputs         Values                   `json:"inputs,omitempty"`
}

// ConfigError is a refused configuration: the rule it breaks and the reason.
type ConfigError struct {
	Rule   string
	Reason string
}

func (e *ConfigError) Error() string { return e.Reason }

// StateError is an operation the device's state does not allow.
type StateError struct {
	Rule   string
	Reason string
}

func (e *StateError) Error() string { return e.Reason }

// ErrNotFound is returned for a device the simulation does not hold.
var ErrNotFound = errors.New("the device is not part of this simulation")

// Status of a device in the runtime, apart from its behaviour's state: OK; FAULTED when
// its behaviour failed inside a step; QUARANTINED when it overran its step budget too
// often. A device that is not OK is skipped and its outputs are frozen until it is
// configured again.
type Status string

const (
	StatusOK          Status = "OK"
	StatusFaulted     Status = "FAULTED"
	StatusQuarantined Status = "QUARANTINED"
)

// Event is a meaningful change of a device. The runtime numbers it and stamps the tick.
type Event struct {
	Seq      uint64         `json:"seq"`
	Tick     uint64         `json:"tick"`
	TimeS    float64        `json:"timeS"`
	Type     string         `json:"type"`
	DeviceID string         `json:"deviceId"`
	Severity Severity       `json:"severity"`
	Payload  map[string]any `json:"payload,omitempty"`
}

// Snapshot is one device as inspecting it shows.
type Snapshot struct {
	DeviceID       string             `json:"deviceId"`
	Name           string             `json:"name"`
	Profile        string             `json:"profile"`
	ProfileVersion int                `json:"profileVersion"`
	Status         Status             `json:"status"`
	State          string             `json:"state"`
	Faulted        bool               `json:"faulted"`
	Tripped        bool               `json:"tripped"`
	ActiveFaults   []string           `json:"activeFaults"`
	Quality        string             `json:"quality"`
	Inputs         Values             `json:"inputs"`
	Outputs        Values             `json:"outputs"`
	Forced         *float64           `json:"forced,omitempty"`
	Internal       map[string]float64 `json:"internal"`
	Error          string             `json:"error,omitempty"`
}

// Options bound what one device may cost per step.
type Options struct {
	// A step longer than this is an overrun; zero means 50 ms.
	StepBudget time.Duration
	// Consecutive overruns before the device is quarantined; zero means 3.
	MaxOverruns int
	// Now measures a step's duration; nil means the wall clock.
	Now func() time.Time
}

// Device is one configured device with its behaviour and the state the simulation
// keeps for every device: faults, trip, inputs, outputs, links.
type Device struct {
	ID         string
	Name       string
	Profile    string
	Version    int
	behavior   Behavior
	faults     map[string]Fault
	active     map[string]bool
	tripped    bool
	resetInput bool
	inputs     Values
	outputs    Values
	state      string
	forced     *float64
	peers      map[string]*Device
	status     Status
	err        string
	overruns   int
	stage      int
	sim        *Simulation
}

// Simulation is the device simulation of one factory: a deterministic set of coupled
// behaviours advanced by Step. It has no clock and no I/O; the runtime feeds it inputs,
// steps it and carries its outputs away.
type Simulation struct {
	FactoryID string
	configs   map[string]Config
	order     []string
	devices   map[string]*Device
	elapsedS  float64
	options   Options
}

// NewSimulation builds the factory's devices and links them. Every device is validated
// and the invariants of the links checked before anything is kept.
func NewSimulation(factoryID string, configs []Config, options Options) (*Simulation, error) {
	if options.StepBudget == 0 {
		options.StepBudget = 50 * time.Millisecond
	}
	if options.MaxOverruns == 0 {
		options.MaxOverruns = 3
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	s := &Simulation{FactoryID: factoryID, configs: map[string]Config{}, devices: map[string]*Device{}, options: options}
	for _, config := range configs {
		if _, taken := s.configs[config.DeviceID]; taken {
			return nil, &ConfigError{Rule: "unique-device", Reason: fmt.Sprintf("device %s is configured twice", config.DeviceID)}
		}
		device, err := s.build(config)
		if err != nil {
			return nil, err
		}
		s.configs[config.DeviceID] = config
		s.order = append(s.order, config.DeviceID)
		s.devices[config.DeviceID] = device
	}
	if err := s.relink(); err != nil {
		return nil, err
	}
	// Settle initial states and outputs without reporting them as changes.
	s.advance(0)
	return s, nil
}

func (s *Simulation) build(config Config) (*Device, error) {
	if config.DeviceID == "" || config.Name == "" {
		return nil, &ConfigError{Rule: "device-identity", Reason: "a device needs deviceId and name"}
	}
	behavior, err := New(config.Profile)
	if err != nil {
		return nil, &ConfigError{Rule: "profile", Reason: fmt.Sprintf("%s: %s", config.Name, err.Error())}
	}
	if config.ProfileVersion != behavior.Version() {
		return nil, &ConfigError{Rule: "profile-version", Reason: fmt.Sprintf("%s: profile %s is version %d, not %d", config.Name, config.Profile, behavior.Version(), config.ProfileVersion)}
	}
	if err := behavior.Configure(config.Parameters); err != nil {
		return nil, &ConfigError{Rule: "simulation-params", Reason: fmt.Sprintf("the simulation parameters of %s are not valid: %s", config.Name, err.Error())}
	}
	description, _ := Describe(config.Profile)
	faults := map[string]Fault{}
	for _, fault := range description.Faults {
		if override, ok := config.Faults[fault.Code]; ok {
			if override.Severity != nil {
				fault.Severity = *override.Severity
			}
			if override.Latching != nil {
				fault.Latching = *override.Latching
			}
		}
		faults[fault.Code] = fault
	}
	for code := range config.Faults {
		if _, known := faults[code]; !known {
			return nil, &ConfigError{Rule: "supported-fault", Reason: fmt.Sprintf("%s does not support the fault %s", config.Name, code)}
		}
	}
	roles := map[string]Link{}
	for _, link := range description.Links {
		roles[link.Role] = link
	}
	for role := range config.Links {
		if _, known := roles[role]; !known {
			return nil, &ConfigError{Rule: "link-role", Reason: fmt.Sprintf("%s has no link %q; its profile %s links %v", config.Name, role, config.Profile, linkRoles(description))}
		}
	}
	inputs := Values{}
	if err := checkInputs(description, config.Inputs); err != nil {
		return nil, &ConfigError{Rule: "input-signal", Reason: fmt.Sprintf("%s: %s", config.Name, err.Error())}
	}
	for key, value := range config.Inputs {
		inputs[key] = value
	}
	return &Device{
		ID:       config.DeviceID,
		Name:     config.Name,
		Profile:  config.Profile,
		Version:  behavior.Version(),
		behavior: behavior,
		faults:   faults,
		active:   map[string]bool{},
		inputs:   inputs,
		outputs:  Values{},
		state:    behavior.State(),
		status:   StatusOK,
		stage:    stageOf(behavior),
		sim:      s,
	}, nil
}

func linkRoles(description Description) []string {
	roles := make([]string, 0, len(description.Links))
	for _, link := range description.Links {
		roles = append(roles, link.Role)
	}
	return roles
}

func checkInputs(description Description, inputs Values) error {
	for key, value := range inputs {
		if !finite(value) {
			return fmt.Errorf("input %s is not a number", key)
		}
		found := false
		for _, signal := range description.Signals {
			if signal.Key == key && signal.Direction == In {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("%s is not an input of profile %s", key, description.Key)
		}
	}
	return nil
}

// stageOf fixes the order of a step: drives, then motors, then loads, then valves and
// everything else that acts, then what observes (sensors, switches).
func stageOf(behavior Behavior) int {
	switch behavior.(type) {
	case *VFD:
		return 0
	case *Motor:
		return 1
	case Load:
		return 2
	case Forcible:
		return 4
	default:
		return 3
	}
}

// relink rebuilds every link from the configurations and checks the invariants: a
// motor's drive is a VFD that drives no other motor; a load's motor is a motor that
// drives no other load; a measured source names a device with that output signal.
func (s *Simulation) relink() error {
	for _, device := range s.devices {
		device.peers = map[string]*Device{}
	}
	for _, id := range s.order {
		device, config := s.devices[id], s.configs[id]
		for role, targetID := range config.Links {
			target, ok := s.devices[targetID]
			if !ok {
				return &ConfigError{Rule: "link-target", Reason: fmt.Sprintf("%s links %s to a device that is not in the factory", device.Name, role)}
			}
			if target == device {
				return &ConfigError{Rule: "link-target", Reason: fmt.Sprintf("%s cannot link to itself", device.Name)}
			}
			switch role {
			case "drive":
				drive, ok := target.behavior.(*VFD)
				if !ok || drive == nil {
					return &ConfigError{Rule: "drive", Reason: fmt.Sprintf("%s is driven by a device that is not a VFD", device.Name)}
				}
				if other := target.peers["motor"]; other != nil {
					return &ConfigError{Rule: "one-motor-per-drive", Reason: fmt.Sprintf("%s already drives %s: one VFD drives one motor", target.Name, other.Name)}
				}
				target.peers["motor"] = device
			case "motor":
				if _, ok := target.behavior.(*Motor); !ok {
					return &ConfigError{Rule: "motor", Reason: fmt.Sprintf("%s is driven by a device that is not a motor", device.Name)}
				}
				if other := target.peers["load"]; other != nil {
					return &ConfigError{Rule: "one-load-per-motor", Reason: fmt.Sprintf("%s already drives %s: one motor drives one load", target.Name, other.Name)}
				}
				target.peers["load"] = device
			case "measures":
				if _, observes := target.behavior.(Forcible); observes {
					return &ConfigError{Rule: "measured-device", Reason: fmt.Sprintf("%s measures a device that produces no process value", device.Name)}
				}
			}
			device.peers[role] = target
		}
		if err := checkMeasuredSource(device); err != nil {
			return err
		}
	}
	return nil
}

// checkMeasuredSource: a sensor or switch with a MEASURED source needs a measured device
// with that output signal (a numeric one for a switch).
func checkMeasuredSource(device *Device) error {
	var signal string
	numeric := false
	switch behavior := device.behavior.(type) {
	case *Sensor:
		if behavior.params.Source.Kind != "MEASURED" {
			return nil
		}
		signal = behavior.params.Source.Signal
	case *Switch:
		if behavior.params.Source.Kind != "MEASURED" {
			return nil
		}
		signal, numeric = behavior.params.Source.Signal, true
	default:
		return nil
	}
	measured := device.peers["measures"]
	if measured == nil {
		return &ConfigError{Rule: "measured-device", Reason: fmt.Sprintf("%s has a measured source but measures no simulated device", device.Name)}
	}
	description, _ := Describe(measured.Profile)
	for _, candidate := range description.Signals {
		if candidate.Key == signal && candidate.Direction == Out && (!numeric || candidate.Kind == Number) {
			return nil
		}
	}
	return &ConfigError{Rule: "measured-signal", Reason: fmt.Sprintf("%s has no output signal %q to measure", measured.Name, signal)}
}

// Upsert adds a device or replaces one (fresh state) and links it; the others keep
// their state. A configuration that breaks an invariant leaves everything as it was.
func (s *Simulation) Upsert(config Config) error {
	device, err := s.build(config)
	if err != nil {
		return err
	}
	previous, existed := s.devices[config.DeviceID]
	previousConfig := s.configs[config.DeviceID]
	s.devices[config.DeviceID] = device
	s.configs[config.DeviceID] = config
	if !existed {
		s.order = append(s.order, config.DeviceID)
	}
	if err := s.relink(); err != nil {
		if existed {
			s.devices[config.DeviceID], s.configs[config.DeviceID] = previous, previousConfig
		} else {
			delete(s.devices, config.DeviceID)
			delete(s.configs, config.DeviceID)
			s.order = s.order[:len(s.order)-1]
		}
		_ = s.relink()
		return err
	}
	s.settle(device)
	return nil
}

// Remove forgets a device. A device another one links to stays until that link is gone.
func (s *Simulation) Remove(deviceID string) error {
	device, ok := s.devices[deviceID]
	if !ok {
		return ErrNotFound
	}
	for _, id := range s.order {
		for role, target := range s.configs[id].Links {
			if target == deviceID {
				return &StateError{Rule: "linked-device", Reason: fmt.Sprintf("%s is the %s of %s; change that first", device.Name, role, s.devices[id].Name)}
			}
		}
	}
	delete(s.devices, deviceID)
	delete(s.configs, deviceID)
	for index, id := range s.order {
		if id == deviceID {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
	return s.relink()
}

// settle computes a new device's outputs from its initial state without a step.
func (s *Simulation) settle(device *Device) {
	device.state = device.behavior.State()
	device.outputs = device.behavior.Outputs(device.context())
}

func (d *Device) context() *Context {
	return &Context{Inputs: d.inputs, Tripped: d.tripped, ActiveFaults: d.active, ElapsedS: d.sim.elapsedS, Forced: d.forced, peers: d.peers, faults: d.faults}
}

// Devices returns the devices in step order.
func (s *Simulation) Devices() []*Device {
	devices := make([]*Device, 0, len(s.order))
	for _, id := range s.order {
		devices = append(devices, s.devices[id])
	}
	sort.SliceStable(devices, func(i, j int) bool { return devices[i].stage < devices[j].stage })
	return devices
}

// Device returns one device.
func (s *Simulation) Device(deviceID string) (*Device, error) {
	device, ok := s.devices[deviceID]
	if !ok {
		return nil, ErrNotFound
	}
	return device, nil
}

// Count is the number of devices.
func (s *Simulation) Count() int { return len(s.devices) }

// SetInputs replaces the PLC-driven inputs of a device. Signals that are not listed count
// as not wired; a key that is not an input of the profile is refused.
func (s *Simulation) SetInputs(deviceID string, inputs Values) error {
	device, err := s.Device(deviceID)
	if err != nil {
		return err
	}
	description, _ := Describe(device.Profile)
	if err := checkInputs(description, inputs); err != nil {
		return &ConfigError{Rule: "input-signal", Reason: fmt.Sprintf("%s: %s", device.Name, err.Error())}
	}
	next := make(Values, len(inputs))
	for key, value := range inputs {
		next[key] = value
	}
	device.inputs = next
	return nil
}

// Outputs are what the PLC reads from a device after the last step.
func (s *Simulation) Outputs(deviceID string) (Values, error) {
	device, err := s.Device(deviceID)
	if err != nil {
		return nil, err
	}
	return copyValues(device.outputs), nil
}

func copyValues(values Values) Values {
	out := make(Values, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}

// Step advances every device by dt seconds and returns the meaningful changes.
func (s *Simulation) Step(dt float64) ([]Event, error) {
	if !finite(dt) || dt < 0 {
		return nil, &ConfigError{Rule: "step", Reason: "the simulation step must be a non-negative time"}
	}
	return s.advance(dt), nil
}

func hasLatchingFault(device *Device) bool {
	for code := range device.active {
		if device.faults[code].Latching {
			return true
		}
	}
	return false
}

// updateTrip: a latching fault trips the device. The trip stays after its cause is gone
// and is released by a rising edge on the PLC's faultReset signal (or an operator reset).
func updateTrip(device *Device) {
	latching := hasLatchingFault(device)
	if latching {
		device.tripped = true
	}
	resetInput := device.inputs.On("faultReset")
	if device.tripped && !latching && resetInput && !device.resetInput {
		device.tripped = false
	}
	device.resetInput = resetInput
}

func (s *Simulation) advance(dt float64) []Event {
	s.elapsedS += dt
	devices := s.Devices()
	before := make([]string, len(devices))
	for index, device := range devices {
		before[index] = device.state
	}
	var events []Event
	for _, device := range devices {
		updateTrip(device)
	}
	// Actors first, then observers, which read what the actors produced in this step.
	for _, observers := range []bool{false, true} {
		for _, device := range devices {
			if (device.stage == 4) == observers {
				events = append(events, s.stepDevice(device, dt)...)
			}
		}
		for _, device := range devices {
			if (device.stage == 4) == observers && device.status == StatusOK {
				device.state = device.behavior.State()
				device.outputs = device.behavior.Outputs(device.context())
			}
		}
	}
	for index, device := range devices {
		if device.status != StatusOK {
			continue
		}
		moved := false
		if sensor, ok := device.behavior.(*Sensor); ok {
			moved = sensor.moved()
		}
		if device.state == before[index] && !moved {
			continue
		}
		severity := Info
		if device.state == "FAULTED" {
			severity = Critical
		}
		events = append(events, Event{
			Type:     stateEvent(device),
			DeviceID: device.ID,
			Severity: severity,
			Payload:  map[string]any{"from": before[index], "to": device.state, "outputs": copyValues(device.outputs), "activeFaults": device.activeFaults()},
		})
	}
	return events
}

func stateEvent(device *Device) string {
	switch device.behavior.(type) {
	case *VFD:
		return "VFD_STATE_CHANGED"
	case *Motor:
		return "MOTOR_STATE_CHANGED"
	case *Pump:
		return "PUMP_STATE_CHANGED"
	case *Valve:
		return "VALVE_STATE_CHANGED"
	case *Sensor:
		return "SENSOR_VALUE_CHANGED"
	default:
		return "DEVICE_STATE_CHANGED"
	}
}

// stepDevice runs one behaviour's step in isolation: a panic faults the device, an
// overrun of the step budget counts towards its quarantine; either way the other
// devices go on and this one's outputs stay as they were.
func (s *Simulation) stepDevice(device *Device, dt float64) (events []Event) {
	if device.status != StatusOK {
		return nil
	}
	started := s.options.Now()
	defer func() {
		if recovered := recover(); recovered != nil {
			device.status = StatusFaulted
			device.err = fmt.Sprintf("the %s behaviour failed: %v", device.Profile, recovered)
			events = append(events, Event{Type: "DEVICE_RUNTIME_FAULT", DeviceID: device.ID, Severity: Critical, Payload: map[string]any{"status": string(device.status), "error": device.err}})
			return
		}
		if s.options.Now().Sub(started) > s.options.StepBudget {
			device.overruns++
			if device.overruns >= s.options.MaxOverruns {
				device.status = StatusQuarantined
				device.err = fmt.Sprintf("the %s behaviour overran its step budget of %s %d times in a row", device.Profile, s.options.StepBudget, device.overruns)
				events = append(events, Event{Type: "DEVICE_QUARANTINED", DeviceID: device.ID, Severity: Critical, Payload: map[string]any{"status": string(device.status), "error": device.err}})
			}
		} else {
			device.overruns = 0
		}
	}()
	device.behavior.Step(dt, device.context())
	return nil
}

func (d *Device) activeFaults() []string {
	codes := make([]string, 0, len(d.active))
	for code := range d.active {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return codes
}

// Quality of a device's value: BAD for a sensor that lost its signal, and for a device
// the runtime has set aside.
func (d *Device) quality() string {
	if d.status != StatusOK {
		return "BAD"
	}
	if sensor, ok := d.behavior.(*Sensor); ok {
		return sensor.Quality()
	}
	return "GOOD"
}

// Snapshot of one device.
func (d *Device) Snapshot() Snapshot {
	return Snapshot{
		DeviceID:       d.ID,
		Name:           d.Name,
		Profile:        d.Profile,
		ProfileVersion: d.Version,
		Status:         d.status,
		State:          d.state,
		Faulted:        d.tripped || len(d.active) > 0,
		Tripped:        d.tripped,
		ActiveFaults:   d.activeFaults(),
		Quality:        d.quality(),
		Inputs:         copyValues(d.inputs),
		Outputs:        copyValues(d.outputs),
		Forced:         d.forced,
		Internal:       d.behavior.Internal(),
		Error:          d.err,
	}
}

// Snapshot of every device, in step order.
func (s *Simulation) Snapshot() []Snapshot {
	devices := s.Devices()
	snapshots := make([]Snapshot, 0, len(devices))
	for _, device := range devices {
		snapshots = append(snapshots, device.Snapshot())
	}
	return snapshots
}

// Status counts the devices by runtime status.
func (s *Simulation) Status() map[Status]int {
	counts := map[Status]int{}
	for _, device := range s.devices {
		counts[device.status]++
	}
	return counts
}

func (s *Simulation) fault(device *Device, code string) (Fault, error) {
	fault, ok := device.faults[code]
	if !ok {
		return Fault{}, &ConfigError{Rule: "supported-fault", Reason: fmt.Sprintf("%s does not support the fault %s", device.Name, code)}
	}
	return fault, nil
}

// InjectFault makes a fault condition present. Its effect shows from the next step.
func (s *Simulation) InjectFault(deviceID, code string) (Event, error) {
	device, err := s.Device(deviceID)
	if err != nil {
		return Event{}, err
	}
	fault, err := s.fault(device, code)
	if err != nil {
		return Event{}, err
	}
	if device.active[code] {
		return Event{}, &StateError{Rule: "fault-active", Reason: fmt.Sprintf("%s is already active on %s", fault.Name, device.Name)}
	}
	device.active[code] = true
	return Event{Type: "FAULT_INJECTED", DeviceID: deviceID, Severity: fault.Severity, Payload: map[string]any{"code": code, "name": fault.Name, "latching": fault.Latching}}, nil
}

// ClearFault removes a fault condition. A device tripped by a latching fault stays tripped until reset.
func (s *Simulation) ClearFault(deviceID, code string) (Event, error) {
	device, err := s.Device(deviceID)
	if err != nil {
		return Event{}, err
	}
	fault, err := s.fault(device, code)
	if err != nil {
		return Event{}, err
	}
	if !device.active[code] {
		return Event{}, &StateError{Rule: "fault-not-active", Reason: fmt.Sprintf("%s is not active on %s", fault.Name, device.Name)}
	}
	delete(device.active, code)
	return Event{Type: "FAULT_CLEARED", DeviceID: deviceID, Severity: Info, Payload: map[string]any{"code": code, "name": fault.Name, "stillTripped": fault.Latching && device.tripped}}, nil
}

// Reset is the operator's reset at the device, like the reset key of a drive. Refused
// while the cause is present.
func (s *Simulation) Reset(deviceID string) (Event, error) {
	device, err := s.Device(deviceID)
	if err != nil {
		return Event{}, err
	}
	if hasLatchingFault(device) {
		return Event{}, &StateError{Rule: "fault-active", Reason: fmt.Sprintf("%s cannot be reset while its fault is still active", device.Name)}
	}
	wasTripped := device.tripped
	device.tripped = false
	return Event{Type: "DEVICE_RESET", DeviceID: deviceID, Severity: Info, Payload: map[string]any{"wasTripped": wasTripped, "activeFaults": device.activeFaults()}}, nil
}

// Force sets the simulated value of a sensor (a number) or a switch (0 or 1); nil
// returns it to its source.
func (s *Simulation) Force(deviceID string, value *float64) (Event, error) {
	device, err := s.Device(deviceID)
	if err != nil {
		return Event{}, err
	}
	forcible, ok := device.behavior.(Forcible)
	if !ok {
		return Event{}, &ConfigError{Rule: "forcible-device", Reason: "only a sensor (number) or a switch (0 or 1) can be forced"}
	}
	if value != nil {
		if !finite(*value) || (forcible.ForcedKind() == Bool && *value != 0 && *value != 1) {
			return Event{}, &ConfigError{Rule: "forcible-device", Reason: "only a sensor (number) or a switch (0 or 1) can be forced"}
		}
	}
	device.forced = value
	if value == nil {
		return Event{Type: "SIMULATED_INPUT_RELEASED", DeviceID: deviceID, Severity: Info, Payload: map[string]any{}}, nil
	}
	return Event{Type: "SIMULATED_INPUT_FORCED", DeviceID: deviceID, Severity: Info, Payload: map[string]any{"value": *value}}, nil
}

// Forced lists the sensors and switches whose value is forced.
func (s *Simulation) Forced() []Snapshot {
	var forced []Snapshot
	for _, device := range s.Devices() {
		if device.forced != nil {
			forced = append(forced, device.Snapshot())
		}
	}
	return forced
}
