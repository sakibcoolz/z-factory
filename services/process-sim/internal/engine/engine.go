// Package engine runs process-model instances: it holds their configuration and state in
// memory, advances them tick by tick, and answers questions about them. Nothing here is
// persisted; Z-Factory owns the configuration and reloads it after a restart.
package engine

import (
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/sim"
)

// ContractVersion is the version of the configuration contract this service accepts.
const ContractVersion = 1

// Clock says what advances an instance: wall time at its tick rate, or manual steps only.
type Clock string

const (
	ClockWall   Clock = "wall"
	ClockManual Clock = "manual"
)

// Status of an instance.
type Status string

const (
	StatusLoaded  Status = "LOADED"
	StatusRunning Status = "RUNNING"
	StatusStopped Status = "STOPPED"
	StatusFaulted Status = "FAULTED"
)

// Config is the versioned configuration of one instance, as Z-Factory sends it.
type Config struct {
	ContractVersion int                `json:"contractVersion"`
	InstanceID      string             `json:"instanceId"`
	FactoryID       string             `json:"factoryId"`
	ModuleType      string             `json:"moduleType"`
	ModelType       string             `json:"modelType"`
	ModelVersion    int                `json:"modelVersion"`
	ConfigVersion   int                `json:"configVersion"`
	TickMs          int                `json:"tickMs"`
	Clock           Clock              `json:"clock"`
	Parameters      map[string]float64 `json:"parameters"`
	Inputs          map[string]float64 `json:"inputs,omitempty"`
}

// Event as recorded: numbered per instance and stamped with the tick it happened at.
type Event struct {
	Seq     uint64             `json:"seq"`
	Tick    uint64             `json:"tick"`
	TimeS   float64            `json:"timeS"`
	Type    string             `json:"type"`
	Message string             `json:"message"`
	Values  map[string]float64 `json:"values,omitempty"`
}

// Snapshot is what inspecting an instance returns.
type Snapshot struct {
	InstanceID    string             `json:"instanceId"`
	FactoryID     string             `json:"factoryId"`
	ModuleType    string             `json:"moduleType"`
	ModelType     string             `json:"modelType"`
	ModelVersion  int                `json:"modelVersion"`
	ConfigVersion int                `json:"configVersion"`
	TickMs        int                `json:"tickMs"`
	Clock         Clock              `json:"clock"`
	Status        Status             `json:"status"`
	Tick          uint64             `json:"tick"`
	TimeS         float64            `json:"timeS"`
	Inputs        map[string]float64 `json:"inputs"`
	Outputs       map[string]float64 `json:"outputs"`
	State         map[string]float64 `json:"state"`
	LastEventSeq  uint64             `json:"lastEventSeq"`
	Error         string             `json:"error,omitempty"`
	LoadedAt      time.Time          `json:"loadedAt"`
}

// ErrNotFound is returned for an instance id the engine does not hold.
var ErrNotFound = errors.New("instance not found")

// ConfigError is a refused configuration, with the reason.
type ConfigError struct{ Reason string }

func (e *ConfigError) Error() string { return "invalid configuration: " + e.Reason }

// StateError is a lifecycle operation the instance's status does not allow.
type StateError struct{ Reason string }

func (e *StateError) Error() string { return e.Reason }

const eventsKept = 200

// Instance is one loaded model with its state. Every method takes its lock.
type Instance struct {
	mu       sync.Mutex
	config   Config
	model    sim.Model
	status   Status
	tick     uint64
	inputs   map[string]float64
	outputs  map[string]float64
	events   []Event
	eventSeq uint64
	err      string
	loadedAt time.Time
	stop     chan struct{}
	log      *slog.Logger
}

// Engine holds the instances and the counters the metrics report.
type Engine struct {
	mu           sync.RWMutex
	instances    map[string]*Instance
	maxInstances int
	log          *slog.Logger
	now          func() time.Time

	ticks        uint64
	tickDuration time.Duration
}

// New returns an empty engine that holds at most maxInstances instances.
func New(log *slog.Logger, maxInstances int) *Engine {
	return &Engine{instances: map[string]*Instance{}, maxInstances: maxInstances, log: log, now: time.Now}
}

// Validate checks a configuration against the contract and the model, without loading it.
func Validate(config Config) (sim.Model, error) {
	if config.ContractVersion != ContractVersion {
		return nil, &ConfigError{fmt.Sprintf("contractVersion %d is not supported; this service speaks %d", config.ContractVersion, ContractVersion)}
	}
	if config.InstanceID == "" || config.FactoryID == "" {
		return nil, &ConfigError{"instanceId and factoryId are required"}
	}
	if config.TickMs < 10 || config.TickMs > 10_000 {
		return nil, &ConfigError{"tickMs must be between 10 and 10000"}
	}
	if config.Clock == "" {
		config.Clock = ClockWall
	}
	if config.Clock != ClockWall && config.Clock != ClockManual {
		return nil, &ConfigError{`clock must be "wall" or "manual"`}
	}
	if config.ConfigVersion < 1 {
		return nil, &ConfigError{"configVersion must be at least 1"}
	}
	model, err := sim.New(config.ModelType)
	if err != nil {
		return nil, &ConfigError{err.Error()}
	}
	if config.ModelVersion != model.Version() {
		return nil, &ConfigError{fmt.Sprintf("model %s is version %d, not %d", model.Type(), model.Version(), config.ModelVersion)}
	}
	if err := model.Reset(config.Parameters); err != nil {
		return nil, &ConfigError{err.Error()}
	}
	known := map[string]bool{}
	for _, name := range model.Inputs() {
		known[name] = true
	}
	for name := range config.Inputs {
		if !known[name] {
			return nil, &ConfigError{fmt.Sprintf("input %s is not an input of %s", name, model.Type())}
		}
	}
	return model, nil
}

// Load stores a configuration as a LOADED instance. An instance of the same id is
// replaced: whatever ran is stopped, and the new one starts from its initial state.
func (e *Engine) Load(config Config) (Snapshot, error) {
	if config.Clock == "" {
		config.Clock = ClockWall
	}
	model, err := Validate(config)
	if err != nil {
		return Snapshot{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if previous, ok := e.instances[config.InstanceID]; ok {
		previous.halt()
	} else if len(e.instances) >= e.maxInstances {
		return Snapshot{}, &ConfigError{fmt.Sprintf("the service holds %d instances, its limit", e.maxInstances)}
	}
	instance := &Instance{
		config:   config,
		model:    model,
		status:   StatusLoaded,
		inputs:   copyValues(config.Inputs),
		outputs:  map[string]float64{},
		loadedAt: e.now(),
		log:      e.log.With("instance", config.InstanceID, "factory", config.FactoryID, "model", config.ModelType),
	}
	e.instances[config.InstanceID] = instance
	instance.log.Info("instance loaded", "configVersion", config.ConfigVersion, "tickMs", config.TickMs, "clock", config.Clock)
	return instance.snapshot(), nil
}

// Unload stops and forgets an instance.
func (e *Engine) Unload(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	instance, ok := e.instances[id]
	if !ok {
		return ErrNotFound
	}
	instance.halt()
	delete(e.instances, id)
	instance.log.Info("instance unloaded")
	return nil
}

// Get returns an instance.
func (e *Engine) Get(id string) (*Instance, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	instance, ok := e.instances[id]
	if !ok {
		return nil, ErrNotFound
	}
	return instance, nil
}

// Inspect returns the snapshot of one instance.
func (e *Engine) Inspect(id string) (Snapshot, error) {
	instance, err := e.Get(id)
	if err != nil {
		return Snapshot{}, err
	}
	return instance.snapshot(), nil
}

// List returns a snapshot of every instance, by id.
func (e *Engine) List() []Snapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()
	snapshots := make([]Snapshot, 0, len(e.instances))
	for _, instance := range e.instances {
		snapshots = append(snapshots, instance.snapshot())
	}
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].InstanceID < snapshots[j].InstanceID })
	return snapshots
}

// Metrics are the counters the service reports.
type Metrics struct {
	Instances      int            `json:"instances"`
	ByStatus       map[Status]int `json:"byStatus"`
	TicksTotal     uint64         `json:"ticksTotal"`
	LastTickMicros int64          `json:"lastTickMicros"`
	ModelTypes     []string       `json:"modelTypes"`
}

// Metrics returns the counters.
func (e *Engine) Metrics() Metrics {
	e.mu.RLock()
	defer e.mu.RUnlock()
	metrics := Metrics{Instances: len(e.instances), ByStatus: map[Status]int{}, TicksTotal: e.ticks, LastTickMicros: e.tickDuration.Microseconds(), ModelTypes: sim.Types()}
	for _, instance := range e.instances {
		metrics.ByStatus[instance.snapshot().Status]++
	}
	return metrics
}

// Shutdown stops every running instance; the engine keeps them as STOPPED.
func (e *Engine) Shutdown() {
	e.mu.RLock()
	defer e.mu.RUnlock()
	for _, instance := range e.instances {
		instance.halt()
	}
}

func (e *Engine) count(duration time.Duration) {
	e.mu.Lock()
	e.ticks++
	e.tickDuration = duration
	e.mu.Unlock()
}

// Start begins advancing the instance. A wall-clock instance ticks on its own; a manual
// one only when stepped. Starting again from STOPPED continues from where it stopped.
func (e *Engine) Start(id string) (Snapshot, error) {
	instance, err := e.Get(id)
	if err != nil {
		return Snapshot{}, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	switch instance.status {
	case StatusRunning:
		return instance.snapshotLocked(), nil
	case StatusFaulted:
		return Snapshot{}, &StateError{"a faulted instance has to be reset before it runs again"}
	}
	instance.status = StatusRunning
	if instance.config.Clock == ClockWall {
		instance.stop = make(chan struct{})
		go instance.run(e, instance.stop)
	}
	instance.log.Info("instance started", "tick", instance.tick)
	return instance.snapshotLocked(), nil
}

// Stop halts a running instance and keeps its state: Start continues it.
func (e *Engine) Stop(id string) (Snapshot, error) {
	instance, err := e.Get(id)
	if err != nil {
		return Snapshot{}, err
	}
	instance.halt()
	instance.mu.Lock()
	defer instance.mu.Unlock()
	if instance.status == StatusRunning {
		instance.status = StatusStopped
		instance.log.Info("instance stopped", "tick", instance.tick)
	}
	return instance.snapshotLocked(), nil
}

// Reset halts the instance and puts the model back to the initial state of its
// configuration: tick zero, the configured inputs, no outputs, the events kept.
func (e *Engine) Reset(id string) (Snapshot, error) {
	instance, err := e.Get(id)
	if err != nil {
		return Snapshot{}, err
	}
	instance.halt()
	instance.mu.Lock()
	defer instance.mu.Unlock()
	if err := instance.model.Reset(instance.config.Parameters); err != nil {
		return Snapshot{}, err
	}
	instance.status = StatusLoaded
	instance.tick = 0
	instance.inputs = copyValues(instance.config.Inputs)
	instance.outputs = map[string]float64{}
	instance.err = ""
	instance.record(sim.Event{Type: "RESET", Message: "instance reset to its initial state"})
	instance.log.Info("instance reset")
	return instance.snapshotLocked(), nil
}

// SetInputs replaces the given inputs; the others keep their value. Unknown names are refused.
func (e *Engine) SetInputs(id string, values map[string]float64) (Snapshot, error) {
	instance, err := e.Get(id)
	if err != nil {
		return Snapshot{}, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	known := map[string]bool{}
	for _, name := range instance.model.Inputs() {
		known[name] = true
	}
	for name, value := range values {
		if !known[name] {
			return Snapshot{}, &ConfigError{fmt.Sprintf("input %s is not an input of %s", name, instance.model.Type())}
		}
		if value != value {
			return Snapshot{}, &ConfigError{fmt.Sprintf("input %s is not a number", name)}
		}
	}
	for name, value := range values {
		instance.inputs[name] = value
	}
	return instance.snapshotLocked(), nil
}

// Step advances a running instance by n ticks at once. For a manual-clock instance this
// is the only way it advances; a wall-clock instance may be stepped too, which is how
// tests reach a state without waiting.
func (e *Engine) Step(id string, n int) (Snapshot, error) {
	if n < 1 || n > 100_000 {
		return Snapshot{}, &ConfigError{"ticks must be between 1 and 100000"}
	}
	instance, err := e.Get(id)
	if err != nil {
		return Snapshot{}, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	if instance.status != StatusRunning {
		return Snapshot{}, &StateError{fmt.Sprintf("the instance is %s, not RUNNING", instance.status)}
	}
	for i := 0; i < n; i++ {
		instance.advanceLocked(e)
	}
	return instance.snapshotLocked(), nil
}

// Events returns the kept events with a sequence number above `after`.
func (e *Engine) Events(id string, after uint64) ([]Event, error) {
	instance, err := e.Get(id)
	if err != nil {
		return nil, err
	}
	instance.mu.Lock()
	defer instance.mu.Unlock()
	var events []Event
	for _, event := range instance.events {
		if event.Seq > after {
			events = append(events, event)
		}
	}
	if events == nil {
		events = []Event{}
	}
	return events, nil
}

// run ticks a wall-clock instance until it is halted. A tick that was missed under load
// is not caught up: simulated time is the tick count, not the wall clock.
func (i *Instance) run(e *Engine, stop chan struct{}) {
	ticker := time.NewTicker(time.Duration(i.config.TickMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			i.mu.Lock()
			if i.status == StatusRunning {
				i.advanceLocked(e)
			}
			i.mu.Unlock()
		}
	}
}

// halt stops the ticker goroutine, if any. Safe to call more than once.
func (i *Instance) halt() {
	i.mu.Lock()
	stop := i.stop
	i.stop = nil
	i.mu.Unlock()
	if stop != nil {
		close(stop)
	}
}

func (i *Instance) advanceLocked(e *Engine) {
	started := time.Now()
	dt := float64(i.config.TickMs) / 1000
	outputs, events := i.model.Step(dt, i.inputs)
	i.tick++
	i.outputs = outputs
	for _, event := range events {
		i.record(event)
	}
	e.count(time.Since(started))
}

func (i *Instance) record(event sim.Event) {
	i.eventSeq++
	i.events = append(i.events, Event{Seq: i.eventSeq, Tick: i.tick, TimeS: i.timeS(), Type: event.Type, Message: event.Message, Values: event.Values})
	if len(i.events) > eventsKept {
		i.events = i.events[len(i.events)-eventsKept:]
	}
	i.log.Info("event", "type", event.Type, "message", event.Message, "tick", i.tick)
}

func (i *Instance) timeS() float64 { return float64(i.tick) * float64(i.config.TickMs) / 1000 }

func (i *Instance) snapshot() Snapshot {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.snapshotLocked()
}

func (i *Instance) snapshotLocked() Snapshot {
	return Snapshot{
		InstanceID:    i.config.InstanceID,
		FactoryID:     i.config.FactoryID,
		ModuleType:    i.config.ModuleType,
		ModelType:     i.config.ModelType,
		ModelVersion:  i.config.ModelVersion,
		ConfigVersion: i.config.ConfigVersion,
		TickMs:        i.config.TickMs,
		Clock:         i.config.Clock,
		Status:        i.status,
		Tick:          i.tick,
		TimeS:         i.timeS(),
		Inputs:        copyValues(i.inputs),
		Outputs:       copyValues(i.outputs),
		State:         i.model.State(),
		LastEventSeq:  i.eventSeq,
		Error:         i.err,
		LoadedAt:      i.loadedAt,
	}
}

func copyValues(values map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}
