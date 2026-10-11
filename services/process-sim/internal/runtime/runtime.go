// Package runtime hosts the catalog device simulations of many factories (TASK-1009):
// one deterministic tick per factory, factories isolated from each other, devices
// isolated from a failing neighbour, bounded in number, and inspectable. Nothing here is
// persisted; Z-Factory owns the configuration and loads it again after a restart.
package runtime

import (
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/modbus"
)

// ContractVersion is the version of the factory configuration contract this runtime accepts.
const ContractVersion = device.ContractVersion

// Clock says what advances a factory: wall time at its tick rate, or manual steps only.
type Clock string

const (
	ClockWall   Clock = "wall"
	ClockManual Clock = "manual"
)

// Status of a factory's simulation.
type Status string

const (
	StatusLoaded  Status = "LOADED"
	StatusRunning Status = "RUNNING"
	StatusStopped Status = "STOPPED"
)

// Config is the device simulation of one factory, as Z-Factory sends it.
type Config struct {
	ContractVersion int             `json:"contractVersion"`
	FactoryID       string          `json:"factoryId"`
	ConfigVersion   int             `json:"configVersion"`
	TickMs          int             `json:"tickMs"`
	Clock           Clock           `json:"clock"`
	Devices         []device.Config `json:"devices"`
	// ModbusTCP opens a listener for the factory's protocol devices (TASK-1013).
	ModbusTCP *ModbusTCPConfig `json:"modbusTcp,omitempty"`
}

// Summary is one factory as listing shows it.
type Summary struct {
	FactoryID       string                `json:"factoryId"`
	ConfigVersion   int                   `json:"configVersion"`
	TickMs          int                   `json:"tickMs"`
	Clock           Clock                 `json:"clock"`
	Status          Status                `json:"status"`
	Tick            uint64                `json:"tick"`
	TimeS           float64               `json:"timeS"`
	DeviceCount     int                   `json:"deviceCount"`
	DevicesByStatus map[device.Status]int `json:"devicesByStatus"`
	LastEventSeq    uint64                `json:"lastEventSeq"`
	LoadedAt        time.Time             `json:"loadedAt"`
	// A wall-clock factory that is RUNNING but has not ticked for five ticks.
	Stalled bool `json:"stalled"`
	// Where the factory's protocol devices are served; absent without a listener.
	ModbusTCP *ModbusTCPStatus `json:"modbusTcp,omitempty"`
}

// Snapshot is a factory with its devices, as inspecting it shows.
type Snapshot struct {
	Summary
	Devices []device.Snapshot `json:"devices"`
}

// ErrNotFound is returned for a factory the runtime does not hold.
var ErrNotFound = errors.New("factory not found")

// ConfigError is a refused factory configuration.
type ConfigError = device.ConfigError

// StateError is a lifecycle operation the factory's status does not allow.
type StateError = device.StateError

const (
	eventsKept           = 500
	maxDevicesPerFactory = 256
	stalledAfterTicks    = 5
)

// Factory is one loaded simulation with its state. Every method takes its lock.
type Factory struct {
	mu         sync.Mutex
	config     Config
	sim        *device.Simulation
	status     Status
	tick       uint64
	events     []device.Event
	eventSeq   uint64
	stop       chan struct{}
	loadedAt   time.Time
	lastTickAt time.Time
	log        *slog.Logger
	listener   *modbus.Server
	rejected   map[string]time.Time
}

// Runtime holds the factories and the counters the metrics report.
type Runtime struct {
	mu         sync.RWMutex
	factories  map[string]*Factory
	maxDevices int
	options    device.Options
	log        *slog.Logger
	now        func() time.Time
	modbus     ModbusOptions

	ticks        uint64
	tickDuration time.Duration
}

// New returns an empty runtime that holds at most maxDevices devices over all factories.
func New(log *slog.Logger, maxDevices int, options device.Options) *Runtime {
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Runtime{factories: map[string]*Factory{}, maxDevices: maxDevices, options: options, log: log, now: time.Now, modbus: defaultModbusOptions()}
}

// Validate checks a configuration against the contract and builds its simulation.
func (r *Runtime) Validate(config Config) (*device.Simulation, error) {
	if config.ContractVersion != ContractVersion {
		return nil, &ConfigError{Rule: "contract-version", Reason: fmt.Sprintf("contractVersion %d is not supported; this runtime speaks %d", config.ContractVersion, ContractVersion)}
	}
	if config.FactoryID == "" {
		return nil, &ConfigError{Rule: "factory-identity", Reason: "factoryId is required"}
	}
	if config.TickMs < 10 || config.TickMs > 10_000 {
		return nil, &ConfigError{Rule: "tick", Reason: "tickMs must be between 10 and 10000"}
	}
	if config.Clock != ClockWall && config.Clock != ClockManual {
		return nil, &ConfigError{Rule: "clock", Reason: `clock must be "wall" or "manual"`}
	}
	if config.ConfigVersion < 1 {
		return nil, &ConfigError{Rule: "config-version", Reason: "configVersion must be at least 1"}
	}
	if len(config.Devices) > maxDevicesPerFactory {
		return nil, &ConfigError{Rule: "device-limit", Reason: fmt.Sprintf("a factory holds at most %d devices", maxDevicesPerFactory)}
	}
	sim, err := device.NewSimulation(config.FactoryID, config.Devices, r.options)
	if err != nil {
		return nil, err
	}
	if err := r.checkModbus(config, sim); err != nil {
		return nil, err
	}
	return sim, nil
}

// Load stores a configuration as a LOADED factory. A factory of the same id is replaced:
// whatever ran is stopped, and the new one starts from its initial state.
func (r *Runtime) Load(config Config) (Snapshot, error) {
	if config.Clock == "" {
		config.Clock = ClockWall
	}
	sim, err := r.Validate(config)
	if err != nil {
		return Snapshot{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, replacing := r.factories[config.FactoryID]
	held := r.deviceCountLocked()
	if replacing {
		held -= previous.sim.Count()
	}
	if held+sim.Count() > r.maxDevices {
		return Snapshot{}, &ConfigError{Rule: "device-limit", Reason: fmt.Sprintf("the runtime holds %d devices, its limit is %d", held, r.maxDevices)}
	}
	if replacing {
		previous.halt()
	}
	factory := &Factory{
		config:   config,
		sim:      sim,
		status:   StatusLoaded,
		loadedAt: r.now(),
		log:      r.log.With("factory", config.FactoryID),
		rejected: map[string]time.Time{},
	}
	// The listener is opened once the previous factory of the id has released its port;
	// if it cannot be opened the replaced factory stays gone and Z-Factory loads again.
	if err := r.listen(factory); err != nil {
		delete(r.factories, config.FactoryID)
		return Snapshot{}, err
	}
	r.factories[config.FactoryID] = factory
	factory.log.Info("factory loaded", "configVersion", config.ConfigVersion, "devices", sim.Count(), "tickMs", config.TickMs, "clock", config.Clock)
	return factory.snapshot(r.now()), nil
}

func (r *Runtime) deviceCountLocked() int {
	count := 0
	for _, factory := range r.factories {
		count += factory.sim.Count()
	}
	return count
}

// Unload stops and forgets a factory.
func (r *Runtime) Unload(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	factory, ok := r.factories[id]
	if !ok {
		return ErrNotFound
	}
	factory.halt()
	delete(r.factories, id)
	factory.log.Info("factory unloaded")
	return nil
}

func (r *Runtime) get(id string) (*Factory, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	factory, ok := r.factories[id]
	if !ok {
		return nil, ErrNotFound
	}
	return factory, nil
}

// Inspect returns a factory with its devices.
func (r *Runtime) Inspect(id string) (Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	return factory.snapshot(r.now()), nil
}

// List returns a summary of every factory, by id.
func (r *Runtime) List() []Summary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	summaries := make([]Summary, 0, len(r.factories))
	for _, factory := range r.factories {
		summaries = append(summaries, factory.snapshot(r.now()).Summary)
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].FactoryID < summaries[j].FactoryID })
	return summaries
}

// Metrics are the counters the service reports for the device runtime.
type Metrics struct {
	Factories         int                   `json:"factories"`
	FactoriesByStatus map[Status]int        `json:"factoriesByStatus"`
	Devices           int                   `json:"devices"`
	DevicesByStatus   map[device.Status]int `json:"devicesByStatus"`
	MaxDevices        int                   `json:"maxDevices"`
	TicksTotal        uint64                `json:"ticksTotal"`
	LastTickMicros    int64                 `json:"lastTickMicros"`
	Stalled           int                   `json:"stalled"`
	Profiles          []string              `json:"profiles"`
}

// Metrics returns the counters.
func (r *Runtime) Metrics() Metrics {
	r.mu.RLock()
	defer r.mu.RUnlock()
	metrics := Metrics{
		Factories:         len(r.factories),
		FactoriesByStatus: map[Status]int{},
		DevicesByStatus:   map[device.Status]int{},
		MaxDevices:        r.maxDevices,
		TicksTotal:        r.ticks,
		LastTickMicros:    r.tickDuration.Microseconds(),
		Profiles:          device.Profiles(),
	}
	for _, factory := range r.factories {
		summary := factory.snapshot(r.now()).Summary
		metrics.FactoriesByStatus[summary.Status]++
		metrics.Devices += summary.DeviceCount
		for status, count := range summary.DevicesByStatus {
			metrics.DevicesByStatus[status] += count
		}
		if summary.Stalled {
			metrics.Stalled++
		}
	}
	return metrics
}

// Shutdown stops every running factory; the runtime keeps them as STOPPED.
func (r *Runtime) Shutdown() {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, factory := range r.factories {
		factory.halt()
	}
}

func (r *Runtime) count(duration time.Duration) {
	r.mu.Lock()
	r.ticks++
	r.tickDuration = duration
	r.mu.Unlock()
}

// Start begins advancing the factory. A wall-clock factory ticks on its own; a manual one
// only when stepped. Starting again from STOPPED continues from where it stopped.
func (r *Runtime) Start(id string) (Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	if factory.status != StatusRunning {
		factory.status = StatusRunning
		factory.lastTickAt = r.now()
		if factory.config.Clock == ClockWall {
			factory.stop = make(chan struct{})
			go factory.run(r, factory.stop)
		}
		factory.log.Info("factory started", "tick", factory.tick)
	}
	return factory.snapshotLocked(r.now()), nil
}

// Stop halts a running factory and keeps its state: Start continues it.
func (r *Runtime) Stop(id string) (Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	factory.halt()
	factory.mu.Lock()
	defer factory.mu.Unlock()
	if factory.status == StatusRunning {
		factory.status = StatusStopped
		factory.log.Info("factory stopped", "tick", factory.tick)
	}
	return factory.snapshotLocked(r.now()), nil
}

// Reset halts the factory and rebuilds every device from its configuration: tick zero,
// fresh state, the events kept and a RESET event recorded.
func (r *Runtime) Reset(id string) (Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	factory.halt()
	factory.mu.Lock()
	defer factory.mu.Unlock()
	sim, err := device.NewSimulation(factory.config.FactoryID, factory.config.Devices, r.options)
	if err != nil {
		return Snapshot{}, err
	}
	factory.sim = sim
	factory.status = StatusLoaded
	factory.tick = 0
	factory.record(device.Event{Type: "RESET", Severity: device.Info, Payload: map[string]any{"message": "factory reset to its initial state"}})
	factory.log.Info("factory reset")
	return factory.snapshotLocked(r.now()), nil
}

// Step advances a running factory by n ticks at once.
func (r *Runtime) Step(id string, n int) (Snapshot, error) {
	if n < 1 || n > 100_000 {
		return Snapshot{}, &ConfigError{Rule: "ticks", Reason: "ticks must be between 1 and 100000"}
	}
	factory, err := r.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	if factory.status != StatusRunning {
		return Snapshot{}, &StateError{Rule: "factory-state", Reason: fmt.Sprintf("the factory is %s, not RUNNING", factory.status)}
	}
	for i := 0; i < n; i++ {
		factory.advanceLocked(r)
	}
	return factory.snapshotLocked(r.now()), nil
}

// withDevice runs an operation on a factory's simulation under its lock.
func (r *Runtime) withDevice(id string, op func(factory *Factory) error) (Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	if err := op(factory); err != nil {
		return Snapshot{}, err
	}
	return factory.snapshotLocked(r.now()), nil
}

// Upsert adds or replaces one device of a running or stopped factory; the others keep their state.
func (r *Runtime) Upsert(id string, config device.Config) (Snapshot, error) {
	return r.withDevice(id, func(factory *Factory) error {
		r.mu.RLock()
		held := r.deviceCountLocked()
		r.mu.RUnlock()
		if _, exists := factory.sim.Device(config.DeviceID); exists != nil {
			if factory.sim.Count() >= maxDevicesPerFactory {
				return &ConfigError{Rule: "device-limit", Reason: fmt.Sprintf("a factory holds at most %d devices", maxDevicesPerFactory)}
			}
			if held >= r.maxDevices {
				return &ConfigError{Rule: "device-limit", Reason: fmt.Sprintf("the runtime holds %d devices, its limit", held)}
			}
		}
		if config.Protocol != nil && factory.listener == nil {
			return &ConfigError{Rule: "modbus-listener", Reason: fmt.Sprintf("%s is a protocol device but the factory has no modbusTcp listener", config.Name)}
		}
		if err := factory.sim.Upsert(config); err != nil {
			return err
		}
		factory.setDeviceConfig(config)
		factory.log.Info("device configured", "device", config.DeviceID, "profile", config.Profile)
		return nil
	})
}

// RemoveDevice forgets one device of a factory.
func (r *Runtime) RemoveDevice(id, deviceID string) (Snapshot, error) {
	return r.withDevice(id, func(factory *Factory) error {
		if err := factory.sim.Remove(deviceID); err != nil {
			return err
		}
		factory.dropDeviceConfig(deviceID)
		factory.log.Info("device removed", "device", deviceID)
		return nil
	})
}

// Device returns one device of a factory.
func (r *Runtime) Device(id, deviceID string) (device.Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return device.Snapshot{}, err
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	found, err := factory.sim.Device(deviceID)
	if err != nil {
		return device.Snapshot{}, err
	}
	return found.Snapshot(), nil
}

// SetInputs replaces the PLC-driven inputs of a device.
func (r *Runtime) SetInputs(id, deviceID string, inputs device.Values) (device.Snapshot, error) {
	return r.deviceOp(id, deviceID, func(factory *Factory) error { return factory.sim.SetInputs(deviceID, inputs) })
}

// InjectFault makes a fault condition present on a device.
func (r *Runtime) InjectFault(id, deviceID, code string) (device.Snapshot, error) {
	return r.deviceEvent(id, deviceID, func(factory *Factory) (device.Event, error) { return factory.sim.InjectFault(deviceID, code) })
}

// ClearFault removes a fault condition from a device.
func (r *Runtime) ClearFault(id, deviceID, code string) (device.Snapshot, error) {
	return r.deviceEvent(id, deviceID, func(factory *Factory) (device.Event, error) { return factory.sim.ClearFault(deviceID, code) })
}

// ResetDevice is the operator's reset at the device.
func (r *Runtime) ResetDevice(id, deviceID string) (device.Snapshot, error) {
	return r.deviceEvent(id, deviceID, func(factory *Factory) (device.Event, error) { return factory.sim.Reset(deviceID) })
}

// Force sets or releases the forced value of a sensor or a switch.
func (r *Runtime) Force(id, deviceID string, value *float64) (device.Snapshot, error) {
	return r.deviceEvent(id, deviceID, func(factory *Factory) (device.Event, error) { return factory.sim.Force(deviceID, value) })
}

func (r *Runtime) deviceOp(id, deviceID string, op func(factory *Factory) error) (device.Snapshot, error) {
	factory, err := r.get(id)
	if err != nil {
		return device.Snapshot{}, err
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	if err := op(factory); err != nil {
		return device.Snapshot{}, err
	}
	found, _ := factory.sim.Device(deviceID)
	return found.Snapshot(), nil
}

func (r *Runtime) deviceEvent(id, deviceID string, op func(factory *Factory) (device.Event, error)) (device.Snapshot, error) {
	return r.deviceOp(id, deviceID, func(factory *Factory) error {
		event, err := op(factory)
		if err != nil {
			return err
		}
		factory.record(event)
		return nil
	})
}

// Events returns the kept events of a factory with a sequence number above `after`.
func (r *Runtime) Events(id string, after uint64) ([]device.Event, error) {
	factory, err := r.get(id)
	if err != nil {
		return nil, err
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	events := []device.Event{}
	for _, event := range factory.events {
		if event.Seq > after {
			events = append(events, event)
		}
	}
	return events, nil
}

func (f *Factory) setDeviceConfig(config device.Config) {
	for index, existing := range f.config.Devices {
		if existing.DeviceID == config.DeviceID {
			f.config.Devices[index] = config
			return
		}
	}
	f.config.Devices = append(f.config.Devices, config)
}

func (f *Factory) dropDeviceConfig(deviceID string) {
	for index, existing := range f.config.Devices {
		if existing.DeviceID == deviceID {
			f.config.Devices = append(f.config.Devices[:index], f.config.Devices[index+1:]...)
			return
		}
	}
}

// run ticks a wall-clock factory until it is halted. A tick missed under load is not
// caught up: simulated time is the tick count, not the wall clock.
func (f *Factory) run(r *Runtime, stop chan struct{}) {
	ticker := time.NewTicker(time.Duration(f.config.TickMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			f.mu.Lock()
			if f.status == StatusRunning {
				f.advanceLocked(r)
			}
			f.mu.Unlock()
		}
	}
}

// halt stops the ticker goroutine, if any, and closes the factory's listener. Safe to
// call more than once.
func (f *Factory) halt() {
	f.mu.Lock()
	stop := f.stop
	f.stop = nil
	listener := f.listener
	f.listener = nil
	f.mu.Unlock()
	if stop != nil {
		close(stop)
	}
	if listener != nil {
		listener.Close()
	}
}

func (f *Factory) advanceLocked(r *Runtime) {
	started := time.Now()
	events, _ := f.sim.Step(float64(f.config.TickMs) / 1000)
	f.tick++
	f.lastTickAt = r.now()
	for _, event := range events {
		f.record(event)
	}
	r.count(time.Since(started))
}

func (f *Factory) timeS() float64 { return float64(f.tick) * float64(f.config.TickMs) / 1000 }

func (f *Factory) record(event device.Event) {
	f.eventSeq++
	event.Seq, event.Tick, event.TimeS = f.eventSeq, f.tick, f.timeS()
	f.events = append(f.events, event)
	if len(f.events) > eventsKept {
		f.events = f.events[len(f.events)-eventsKept:]
	}
	f.log.Info("event", "type", event.Type, "device", event.DeviceID, "tick", f.tick)
}

func (f *Factory) snapshot(now time.Time) Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshotLocked(now)
}

func (f *Factory) snapshotLocked(now time.Time) Snapshot {
	stalled := f.status == StatusRunning && f.config.Clock == ClockWall &&
		now.Sub(f.lastTickAt) > time.Duration(stalledAfterTicks*f.config.TickMs)*time.Millisecond
	return Snapshot{
		Summary: Summary{
			FactoryID:       f.config.FactoryID,
			ConfigVersion:   f.config.ConfigVersion,
			TickMs:          f.config.TickMs,
			Clock:           f.config.Clock,
			Status:          f.status,
			Tick:            f.tick,
			TimeS:           f.timeS(),
			DeviceCount:     f.sim.Count(),
			DevicesByStatus: f.sim.Status(),
			LastEventSeq:    f.eventSeq,
			LoadedAt:        f.loadedAt,
			Stalled:         stalled,
			ModbusTCP:       f.modbusStatusLocked(),
		},
		Devices: f.sim.Snapshot(),
	}
}
