package runtime

import (
	"errors"
	"fmt"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/modbus"
)

// A factory with protocol-controlled devices (TASK-1013) serves them over one Modbus TCP
// listener: every device answers at its unit id with exactly the registers its declared
// map names. Reads give the device's commands as last written and its feedback as the
// behaviour produced it; a write sets the behaviour's inputs, only on a writable
// register and within the signal's range. Anything else answers an exception before the
// device is touched, and the PLC remains the control authority: the runtime never writes
// a PLC output, it only takes what a PLC (or a test client) writes to the device.

// ModbusTCPConfig asks the runtime to serve the factory's protocol devices on a port of
// its range; 0 takes any free port.
type ModbusTCPConfig struct {
	Port int `json:"port"`
}

// ModbusTCPStatus is where a factory's devices are served, as the summary shows it.
type ModbusTCPStatus struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	// Devices served, by unit id.
	Devices int `json:"devices"`
}

// ModbusOptions say where the runtime may listen.
type ModbusOptions struct {
	Bind    string
	MinPort int
	MaxPort int
}

const rejectionEventInterval = 30 * time.Second

func defaultModbusOptions() ModbusOptions {
	return ModbusOptions{Bind: "127.0.0.1", MinPort: 17000, MaxPort: 17999}
}

// ConfigureModbus sets the bind address and the port range of the factories' listeners.
func (r *Runtime) ConfigureModbus(options ModbusOptions) error {
	if options.Bind == "" || options.MinPort < 1 || options.MaxPort > 65535 || options.MinPort > options.MaxPort {
		return errors.New("the Modbus bind address and port range are not valid")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.modbus = options
	return nil
}

// checkModbus is the factory-level rule: protocol devices need a listener, and its port
// is one of the runtime's range.
func (r *Runtime) checkModbus(config Config, sim *device.Simulation) error {
	units := sim.ProtocolUnits()
	if config.ModbusTCP == nil {
		if len(units) > 0 {
			return &ConfigError{Rule: "modbus-listener", Reason: "the factory has protocol devices but no modbusTcp listener; give it a port, or 0 for any free port"}
		}
		return nil
	}
	r.mu.RLock()
	options := r.modbus
	r.mu.RUnlock()
	port := config.ModbusTCP.Port
	if port != 0 && (port < options.MinPort || port > options.MaxPort) {
		return &ConfigError{Rule: "modbus-port", Reason: fmt.Sprintf("the Modbus port must be 0 or between %d and %d", options.MinPort, options.MaxPort)}
	}
	return nil
}

// listen opens the factory's listener, if its configuration asks for one. Called with
// the runtime's lock held, so the options are read directly.
func (r *Runtime) listen(factory *Factory) error {
	if factory.config.ModbusTCP == nil {
		return nil
	}
	options := r.modbus
	address := fmt.Sprintf("%s:%d", options.Bind, factory.config.ModbusTCP.Port)
	server, err := modbus.Listen(address, &factoryHandler{factory: factory}, modbus.Options{})
	if err != nil {
		return &ConfigError{Rule: "modbus-listen", Reason: fmt.Sprintf("the Modbus listener could not be opened on %s: %s", address, err.Error())}
	}
	factory.listener = server
	factory.log.Info("modbus listener opened", "address", server.Addr().String())
	return nil
}

func (f *Factory) modbusStatusLocked() *ModbusTCPStatus {
	if f.listener == nil {
		return nil
	}
	return &ModbusTCPStatus{Address: f.listener.Addr().String(), Port: f.listener.Port(), Devices: len(f.sim.ProtocolUnits())}
}

// factoryHandler answers the factory's Modbus requests under the factory's lock, so a
// read sees one consistent step and a write lands between two steps.
type factoryHandler struct {
	factory *Factory
}

func (h *factoryHandler) device(unit byte) (string, error) {
	deviceID, ok := h.factory.sim.ProtocolUnits()[int(unit)]
	if !ok {
		return "", modbus.Exception(modbus.GatewayPathUnavailable)
	}
	// A device whose communication is lost answers as a target that does not respond (TASK-1014).
	if h.factory.sim.Unreachable(deviceID) {
		return "", modbus.Exception(modbus.GatewayTargetFailed)
	}
	return deviceID, nil
}

func toModbus(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, device.ErrUnmapped):
		return modbus.Exception(modbus.IllegalDataAddress)
	case errors.Is(err, device.ErrOutOfRange):
		return modbus.Exception(modbus.IllegalDataValue)
	case errors.Is(err, device.ErrNoProtocol), errors.Is(err, device.ErrNotFound):
		return modbus.Exception(modbus.GatewayPathUnavailable)
	default:
		return modbus.Exception(modbus.ServerDeviceFailure)
	}
}

func (h *factoryHandler) ReadBits(unit byte, area modbus.Area, address, count int) ([]bool, error) {
	h.factory.mu.Lock()
	defer h.factory.mu.Unlock()
	deviceID, err := h.device(unit)
	if err != nil {
		return nil, err
	}
	bits, err := h.factory.sim.ReadBits(deviceID, device.Area(area), address, count)
	return bits, toModbus(err)
}

func (h *factoryHandler) ReadRegisters(unit byte, area modbus.Area, address, count int) ([]uint16, error) {
	h.factory.mu.Lock()
	defer h.factory.mu.Unlock()
	deviceID, err := h.device(unit)
	if err != nil {
		return nil, err
	}
	words, err := h.factory.sim.ReadRegisters(deviceID, device.Area(area), address, count)
	return words, toModbus(err)
}

func (h *factoryHandler) WriteBits(unit byte, address int, values []bool) error {
	h.factory.mu.Lock()
	defer h.factory.mu.Unlock()
	deviceID, err := h.device(unit)
	if err != nil {
		return err
	}
	written, err := h.factory.sim.WriteBits(deviceID, address, values)
	return h.recordWrite(deviceID, unit, modbus.Coil, address, written, err)
}

func (h *factoryHandler) WriteRegisters(unit byte, address int, values []uint16) error {
	h.factory.mu.Lock()
	defer h.factory.mu.Unlock()
	deviceID, err := h.device(unit)
	if err != nil {
		return err
	}
	written, err := h.factory.sim.WriteRegisters(deviceID, address, values)
	return h.recordWrite(deviceID, unit, modbus.HoldingRegister, address, written, err)
}

// recordWrite records every changed signal as PROTOCOL_WRITE, and a refusal as
// PROTOCOL_WRITE_REJECTED at most once per address every 30 seconds, so a client that
// keeps writing the wrong register cannot flood the events.
func (h *factoryHandler) recordWrite(deviceID string, unit byte, area modbus.Area, address int, written []device.Written, err error) error {
	f := h.factory
	if err != nil {
		key := fmt.Sprintf("%s:%s:%d", deviceID, area, address)
		now := time.Now()
		if last, seen := f.rejected[key]; !seen || now.Sub(last) >= rejectionEventInterval {
			f.rejected[key] = now
			f.record(device.Event{
				Type: "PROTOCOL_WRITE_REJECTED", DeviceID: deviceID, Severity: device.Warning,
				Payload: map[string]any{"unitId": int(unit), "area": string(area), "address": address, "reason": err.Error()},
			})
		}
		return toModbus(err)
	}
	for _, item := range written {
		if !item.Changed {
			continue
		}
		f.record(device.Event{
			Type: "PROTOCOL_WRITE", DeviceID: deviceID, Severity: device.Info,
			Payload: map[string]any{"unitId": int(unit), "area": string(area), "signal": item.Signal, "value": item.Value},
		})
	}
	return nil
}
