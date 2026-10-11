package device

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
)

// A register map (TASK-1013) is how a protocol-controlled device exposes the signals of
// its behaviour profile: every register is one signal of the profile at one area and
// address, with its data type, scaling, unit, access and role. A map is declared, never
// derived: the runtime serves exactly what a map states, writes land only on registers
// that are writable (the profile's inputs) within the signal's range, and an address no
// map names answers an exception. Z-Factory ships generic maps of its own; a vendor's
// map is catalog data with its provenance and is never guessed.

// Area is a Modbus data area, as the server's tag registry names them.
type Area string

const (
	Coil            Area = "COIL"
	DiscreteInput   Area = "DISCRETE_INPUT"
	HoldingRegister Area = "HOLDING_REGISTER"
	InputRegister   Area = "INPUT_REGISTER"
)

// ProtocolModbusTCP is the one protocol the runtime serves today.
const ProtocolModbusTCP = "MODBUS_TCP"

// RegisterRange bounds the engineering value a writable register accepts: by numbers,
// or by the parameter of the device that sets the bound (a setpoint up to maxFrequencyHz).
type RegisterRange struct {
	Min          *float64 `json:"min,omitempty"`
	Max          *float64 `json:"max,omitempty"`
	MinParameter string   `json:"minParameter,omitempty"`
	MaxParameter string   `json:"maxParameter,omitempty"`
}

// RegisterSpec is one signal of the profile at one address.
type RegisterSpec struct {
	Signal    string `json:"signal"`
	Area      Area   `json:"area"`
	Address   int    `json:"address"`
	DataType  string `json:"dataType"`
	WordCount int    `json:"wordCount"`
	// Engineering value = raw × scale + offset.
	Scale  float64 `json:"scale"`
	Offset float64 `json:"offset"`
	Unit   string  `json:"unit,omitempty"`
	// READ_WRITE for a signal the PLC drives, READ_ONLY for one the device produces.
	Access string `json:"access"`
	// The tag role the register would have in the PLC's registry.
	Role  string         `json:"role"`
	Range *RegisterRange `json:"range,omitempty"`
}

// Conventions of a map, fixed for every map the runtime serves.
type Conventions struct {
	Addressing string `json:"addressing"`
	ByteOrder  string `json:"byteOrder"`
	WordOrder  string `json:"wordOrder"`
}

// RegisterMap is the declared register map of one behaviour profile.
type RegisterMap struct {
	Key            string         `json:"key"`
	Version        int            `json:"version"`
	Protocol       string         `json:"protocol"`
	Profile        string         `json:"profile"`
	ProfileVersion int            `json:"profileVersion"`
	Summary        string         `json:"summary"`
	Conventions    Conventions    `json:"conventions"`
	Registers      []RegisterSpec `json:"registers"`
	// Faults a device gains by being served over the protocol (TASK-1014): COMM_LOSS.
	Faults []Fault `json:"faults"`
}

// ProtocolConfig is how a device of a factory is served: the protocol, the unit id the
// PLC addresses it by, and the declared map it exposes.
type ProtocolConfig struct {
	Kind               string `json:"kind"`
	UnitID             int    `json:"unitId"`
	RegisterMap        string `json:"registerMap"`
	RegisterMapVersion int    `json:"registerMapVersion"`
}

var modbusConventions = Conventions{Addressing: "zero-based", ByteOrder: "BIG_ENDIAN", WordOrder: "HIGH_WORD_FIRST"}

var (
	mapsMu sync.RWMutex
	maps   = map[string]RegisterMap{}
)

// RegisterMapOf declares a register map. It panics when the map does not fit its
// profile: a map is part of the contract and a wrong one is a programming error.
func RegisterMapOf(registerMap RegisterMap) {
	if err := checkRegisterMap(registerMap); err != nil {
		panic(fmt.Sprintf("register map %s: %s", registerMap.Key, err.Error()))
	}
	registerMap.Conventions = modbusConventions
	registerMap.Faults = []Fault{CommLossFault}
	mapsMu.Lock()
	defer mapsMu.Unlock()
	if _, exists := maps[registerMap.Key]; exists {
		panic("register map registered twice: " + registerMap.Key)
	}
	maps[registerMap.Key] = registerMap
}

// RegisterMaps lists the keys of the declared maps, sorted.
func RegisterMaps() []string {
	mapsMu.RLock()
	defer mapsMu.RUnlock()
	keys := make([]string, 0, len(maps))
	for key := range maps {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// DescribeRegisterMap returns a declared map.
func DescribeRegisterMap(key string) (RegisterMap, error) {
	mapsMu.RLock()
	defer mapsMu.RUnlock()
	registerMap, ok := maps[key]
	if !ok {
		return RegisterMap{}, fmt.Errorf("unknown register map %q", key)
	}
	return registerMap, nil
}

func isBitArea(area Area) bool { return area == Coil || area == DiscreteInput }

func checkRegisterMap(registerMap RegisterMap) error {
	if registerMap.Key == "" || registerMap.Version < 1 {
		return errors.New("a map needs a key and a version")
	}
	if registerMap.Protocol != ProtocolModbusTCP {
		return fmt.Errorf("protocol %q is not served", registerMap.Protocol)
	}
	description, err := Describe(registerMap.Profile)
	if err != nil {
		return err
	}
	if description.Version != registerMap.ProfileVersion {
		return fmt.Errorf("profile %s is version %d, not %d", registerMap.Profile, description.Version, registerMap.ProfileVersion)
	}
	if len(registerMap.Registers) == 0 {
		return errors.New("a map names at least one register")
	}
	taken := map[string]bool{}
	for _, register := range registerMap.Registers {
		var signal *Signal
		for index := range description.Signals {
			if description.Signals[index].Key == register.Signal {
				signal = &description.Signals[index]
			}
		}
		if signal == nil {
			return fmt.Errorf("register %s is not a signal of profile %s", register.Signal, registerMap.Profile)
		}
		if register.Address < 0 || register.Address >= 65536 {
			return fmt.Errorf("register %s: address out of the Modbus address space", register.Signal)
		}
		if register.WordCount != 1 {
			return fmt.Errorf("register %s: only single-word registers are served", register.Signal)
		}
		// The area follows the signal: commands and setpoints are writable, feedback is not.
		var wanted Area
		switch {
		case signal.Direction == In && signal.Kind == Bool:
			wanted = Coil
		case signal.Direction == In:
			wanted = HoldingRegister
		case signal.Kind == Bool:
			wanted = DiscreteInput
		default:
			wanted = InputRegister
		}
		if register.Area != wanted {
			return fmt.Errorf("register %s: a %s %s signal lives in %s, not %s", register.Signal, signal.Direction, signal.Kind, wanted, register.Area)
		}
		if isBitArea(register.Area) != (register.DataType == "BOOL") {
			return fmt.Errorf("register %s: bit areas carry BOOL and register areas a word type", register.Signal)
		}
		if !isBitArea(register.Area) && register.DataType != "UINT16" && register.DataType != "INT16" {
			return fmt.Errorf("register %s: data type %s is not served", register.Signal, register.DataType)
		}
		wantedAccess := "READ_ONLY"
		if signal.Direction == In {
			wantedAccess = "READ_WRITE"
		}
		if register.Access != wantedAccess {
			return fmt.Errorf("register %s: a %s signal is %s", register.Signal, signal.Direction, wantedAccess)
		}
		if register.Scale <= 0 || !finite(register.Scale) || !finite(register.Offset) {
			return fmt.Errorf("register %s: scale must be positive", register.Signal)
		}
		if isBitArea(register.Area) && (register.Scale != 1 || register.Offset != 0) {
			return fmt.Errorf("register %s: a bit is not scaled", register.Signal)
		}
		roles := map[string]bool{"FEEDBACK": true, "STATUS": true, "ALARM": true, "PROCESS_VALUE": true}
		if signal.Direction == In {
			roles = map[string]bool{"COMMAND": true, "SETPOINT": true}
		}
		if !roles[register.Role] {
			return fmt.Errorf("register %s: role %s does not fit a %s signal", register.Signal, register.Role, signal.Direction)
		}
		if register.Range != nil && signal.Direction != In {
			return fmt.Errorf("register %s: only a writable register has a range", register.Signal)
		}
		if register.Range != nil {
			for _, parameter := range []string{register.Range.MinParameter, register.Range.MaxParameter} {
				if parameter == "" {
					continue
				}
				found := false
				for _, spec := range description.ParameterSchema {
					if spec.Key == parameter {
						found = true
					}
				}
				if !found {
					return fmt.Errorf("register %s: range names a parameter %s the profile does not have", register.Signal, parameter)
				}
			}
		}
		slot := fmt.Sprintf("%s:%d", register.Area, register.Address)
		if taken[slot] {
			return fmt.Errorf("register %s: %s is used twice", register.Signal, slot)
		}
		taken[slot] = true
		if taken["signal:"+register.Signal] {
			return fmt.Errorf("register %s: the signal is mapped twice", register.Signal)
		}
		taken["signal:"+register.Signal] = true
	}
	return nil
}

// checkProtocol validates a device's protocol configuration against the declared maps.
func checkProtocol(config Config) (*RegisterMap, error) {
	protocol := config.Protocol
	if protocol == nil {
		return nil, nil
	}
	if protocol.Kind != ProtocolModbusTCP {
		return nil, &ConfigError{Rule: "protocol-kind", Reason: fmt.Sprintf("%s: protocol %q is not served; the runtime serves %s", config.Name, protocol.Kind, ProtocolModbusTCP)}
	}
	if protocol.UnitID < 1 || protocol.UnitID > 247 {
		return nil, &ConfigError{Rule: "unit-id", Reason: fmt.Sprintf("%s: a Modbus unit id is 1 to 247, not %d", config.Name, protocol.UnitID)}
	}
	registerMap, err := DescribeRegisterMap(protocol.RegisterMap)
	if err != nil {
		return nil, &ConfigError{Rule: "register-map", Reason: fmt.Sprintf("%s: %s; the runtime serves %v", config.Name, err.Error(), RegisterMaps())}
	}
	if registerMap.Version != protocol.RegisterMapVersion {
		return nil, &ConfigError{Rule: "register-map-version", Reason: fmt.Sprintf("%s: register map %s is version %d, not %d", config.Name, registerMap.Key, registerMap.Version, protocol.RegisterMapVersion)}
	}
	if registerMap.Profile != config.Profile || registerMap.ProfileVersion != config.ProfileVersion {
		return nil, &ConfigError{Rule: "register-map-profile", Reason: fmt.Sprintf("%s: register map %s is the map of profile %s v%d, not of %s v%d", config.Name, registerMap.Key, registerMap.Profile, registerMap.ProfileVersion, config.Profile, config.ProfileVersion)}
	}
	return &registerMap, nil
}

// Errors a register access answers; the server turns them into Modbus exceptions.
var (
	// ErrUnmapped is an address the device's map does not name, or a write to one it
	// does not allow writing.
	ErrUnmapped = errors.New("the address is not a register of this device")
	// ErrOutOfRange is a written value the signal's range excludes.
	ErrOutOfRange = errors.New("the value is outside the register's range")
	// ErrNoProtocol is a device that is not served over a protocol.
	ErrNoProtocol = errors.New("the device has no protocol")
)

// Written is one signal a register write set.
type Written struct {
	Signal  string
	Value   float64
	Changed bool
}

// Unreachable says whether a served device is to answer nothing: its communication is lost.
func (s *Simulation) Unreachable(deviceID string) bool {
	device, err := s.Device(deviceID)
	return err == nil && device.active[CommLossFault.Code]
}

// ProtocolUnits maps the unit id of every protocol device to its id.
func (s *Simulation) ProtocolUnits() map[int]string {
	units := map[int]string{}
	for id, config := range s.configs {
		if config.Protocol != nil {
			units[config.Protocol.UnitID] = id
		}
	}
	return units
}

func (s *Simulation) registerDevice(deviceID string) (*Device, *RegisterMap, error) {
	device, err := s.Device(deviceID)
	if err != nil {
		return nil, nil, err
	}
	if device.registers == nil {
		return nil, nil, ErrNoProtocol
	}
	return device, device.registers, nil
}

func (m *RegisterMap) at(area Area, address int) *RegisterSpec {
	for index := range m.Registers {
		if m.Registers[index].Area == area && m.Registers[index].Address == address {
			return &m.Registers[index]
		}
	}
	return nil
}

// ReadBits reads coils (the device's commands, as last written) or discrete inputs (its
// boolean feedback). Every address must be a register of the map.
func (s *Simulation) ReadBits(deviceID string, area Area, address, count int) ([]bool, error) {
	device, registers, err := s.registerDevice(deviceID)
	if err != nil {
		return nil, err
	}
	if area != Coil && area != DiscreteInput {
		return nil, ErrUnmapped
	}
	bits := make([]bool, count)
	for index := range bits {
		register := registers.at(area, address+index)
		if register == nil {
			return nil, ErrUnmapped
		}
		source := device.outputs
		if area == Coil {
			source = device.inputs
		}
		bits[index] = source[register.Signal] > 0.5
	}
	return bits, nil
}

// ReadRegisters reads holding registers (the device's setpoints, as last written) or
// input registers (its numeric feedback), scaled to raw words.
func (s *Simulation) ReadRegisters(deviceID string, area Area, address, count int) ([]uint16, error) {
	device, registers, err := s.registerDevice(deviceID)
	if err != nil {
		return nil, err
	}
	if area != HoldingRegister && area != InputRegister {
		return nil, ErrUnmapped
	}
	words := make([]uint16, count)
	for index := range words {
		register := registers.at(area, address+index)
		if register == nil {
			return nil, ErrUnmapped
		}
		source := device.outputs
		if area == HoldingRegister {
			source = device.inputs
		}
		words[index] = toRaw(register, source[register.Signal])
	}
	return words, nil
}

// toRaw scales an engineering value to the register's word, saturating at the type's ends.
func toRaw(register *RegisterSpec, value float64) uint16 {
	raw := math.Round((value - register.Offset) / register.Scale)
	if register.DataType == "INT16" {
		return uint16(int16(clamp(raw, math.MinInt16, math.MaxInt16)))
	}
	return uint16(clamp(raw, 0, math.MaxUint16))
}

func fromRaw(register *RegisterSpec, word uint16) float64 {
	raw := float64(word)
	if register.DataType == "INT16" {
		raw = float64(int16(word))
	}
	return raw*register.Scale + register.Offset
}

// WriteBits sets the commands behind consecutive coils. Every address must be a coil of
// the map, or nothing is written.
func (s *Simulation) WriteBits(deviceID string, address int, values []bool) ([]Written, error) {
	device, registers, err := s.registerDevice(deviceID)
	if err != nil {
		return nil, err
	}
	written := make([]Written, 0, len(values))
	for index, value := range values {
		register := registers.at(Coil, address+index)
		if register == nil {
			return nil, ErrUnmapped
		}
		written = append(written, Written{Signal: register.Signal, Value: asFloat(value)})
	}
	return s.applyWrites(device, written), nil
}

// WriteRegisters sets the setpoints behind consecutive holding registers, each checked
// against its range. Every address must be a holding register of the map and every
// value within range, or nothing is written.
func (s *Simulation) WriteRegisters(deviceID string, address int, words []uint16) ([]Written, error) {
	device, registers, err := s.registerDevice(deviceID)
	if err != nil {
		return nil, err
	}
	written := make([]Written, 0, len(words))
	for index, word := range words {
		register := registers.at(HoldingRegister, address+index)
		if register == nil {
			return nil, ErrUnmapped
		}
		value := fromRaw(register, word)
		if !s.inRange(device, register, value) {
			return nil, ErrOutOfRange
		}
		written = append(written, Written{Signal: register.Signal, Value: value})
	}
	return s.applyWrites(device, written), nil
}

func (s *Simulation) applyWrites(device *Device, written []Written) []Written {
	for index := range written {
		before, had := device.inputs[written[index].Signal]
		written[index].Changed = !had || before != written[index].Value
		device.inputs[written[index].Signal] = written[index].Value
	}
	return written
}

// inRange checks a written value against the register's range, resolving a bound that
// names a parameter from the device's effective parameters.
func (s *Simulation) inRange(device *Device, register *RegisterSpec, value float64) bool {
	if register.Range == nil {
		return true
	}
	bound := func(fixed *float64, parameter string) (float64, bool) {
		if fixed != nil {
			return *fixed, true
		}
		if parameter != "" {
			return s.parameter(device, parameter)
		}
		return 0, false
	}
	if min, ok := bound(register.Range.Min, register.Range.MinParameter); ok && value < min {
		return false
	}
	if max, ok := bound(register.Range.Max, register.Range.MaxParameter); ok && value > max {
		return false
	}
	return true
}

// parameter is the effective numeric value of a device's parameter: the configured
// value, else the profile's generic default.
func (s *Simulation) parameter(device *Device, key string) (float64, bool) {
	config := s.configs[device.ID]
	for _, raw := range []json.RawMessage{config.Parameters, describedDefaults(device.Profile)} {
		if len(raw) == 0 {
			continue
		}
		var values map[string]any
		if err := json.Unmarshal(raw, &values); err != nil {
			continue
		}
		if number, ok := values[key].(float64); ok {
			return number, true
		}
	}
	return 0, false
}

func describedDefaults(profile string) json.RawMessage {
	description, err := Describe(profile)
	if err != nil {
		return nil
	}
	return description.Parameters
}
