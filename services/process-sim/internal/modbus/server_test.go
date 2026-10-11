package modbus

import (
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// memory is a handler with a few mapped addresses per area for unit 1 only.
type memory struct {
	mu        sync.Mutex
	coils     map[int]bool
	holding   map[int]uint16
	inputs    map[int]bool
	registers map[int]uint16
}

func newMemory() *memory {
	return &memory{
		coils: map[int]bool{0: false, 1: false, 2: false}, holding: map[int]uint16{0: 0, 1: 0},
		inputs: map[int]bool{0: true, 1: false}, registers: map[int]uint16{0: 1234, 1: 5},
	}
}

func (m *memory) ReadBits(unit byte, area Area, address, count int) ([]bool, error) {
	if unit != 1 {
		return nil, Exception(GatewayPathUnavailable)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	source := m.coils
	if area == DiscreteInput {
		source = m.inputs
	}
	out := make([]bool, count)
	for index := range out {
		value, ok := source[address+index]
		if !ok {
			return nil, Exception(IllegalDataAddress)
		}
		out[index] = value
	}
	return out, nil
}

func (m *memory) ReadRegisters(unit byte, area Area, address, count int) ([]uint16, error) {
	if unit != 1 {
		return nil, Exception(GatewayPathUnavailable)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	source := m.holding
	if area == InputRegister {
		source = m.registers
	}
	out := make([]uint16, count)
	for index := range out {
		value, ok := source[address+index]
		if !ok {
			return nil, Exception(IllegalDataAddress)
		}
		out[index] = value
	}
	return out, nil
}

func (m *memory) WriteBits(unit byte, address int, values []bool) error {
	if unit != 1 {
		return Exception(GatewayPathUnavailable)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for index := range values {
		if _, ok := m.coils[address+index]; !ok {
			return Exception(IllegalDataAddress)
		}
	}
	for index, value := range values {
		m.coils[address+index] = value
	}
	return nil
}

func (m *memory) WriteRegisters(unit byte, address int, values []uint16) error {
	if unit != 1 {
		return Exception(GatewayPathUnavailable)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for index, value := range values {
		if _, ok := m.holding[address+index]; !ok {
			return Exception(IllegalDataAddress)
		}
		if value > 10000 {
			return Exception(IllegalDataValue)
		}
	}
	for index, value := range values {
		m.holding[address+index] = value
	}
	return nil
}

func start(t *testing.T, handler Handler, options Options) (*Server, Client) {
	t.Helper()
	server, err := Listen("127.0.0.1:0", handler, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return server, Client{Address: server.Addr().String(), Unit: 1, Timeout: 2 * time.Second}
}

func expectException(t *testing.T, err error, code byte) {
	t.Helper()
	var exception Exception
	if !errors.As(err, &exception) || byte(exception) != code {
		t.Fatalf("expected exception %02x, got %v", code, err)
	}
}

func TestReadsAndWritesEveryFunction(t *testing.T) {
	memory := newMemory()
	_, client := start(t, memory, Options{})
	bits, err := client.ReadBits(DiscreteInput, 0, 2)
	if err != nil || !bits[0] || bits[1] {
		t.Fatalf("discrete inputs: %v %v", bits, err)
	}
	words, err := client.ReadRegisters(InputRegister, 0, 2)
	if err != nil || words[0] != 1234 || words[1] != 5 {
		t.Fatalf("input registers: %v %v", words, err)
	}
	if err := client.WriteCoil(1, true); err != nil {
		t.Fatal(err)
	}
	if err := client.WriteRegister(0, 4200); err != nil {
		t.Fatal(err)
	}
	if err := client.WriteCoils(0, []bool{true, false, true}); err != nil {
		t.Fatal(err)
	}
	if err := client.WriteRegisters(0, []uint16{7, 8}); err != nil {
		t.Fatal(err)
	}
	coils, _ := client.ReadBits(Coil, 0, 3)
	holding, _ := client.ReadRegisters(HoldingRegister, 0, 2)
	if !coils[0] || coils[1] || !coils[2] || holding[0] != 7 || holding[1] != 8 {
		t.Fatalf("after writes: coils %v holding %v", coils, holding)
	}
}

func TestRefusesWhatTheHandlerAndTheProtocolExclude(t *testing.T) {
	memory := newMemory()
	_, client := start(t, memory, Options{})
	_, err := client.ReadBits(Coil, 2, 2)
	expectException(t, err, IllegalDataAddress)
	expectException(t, client.WriteRegister(0, 60000), IllegalDataValue)
	expectException(t, client.WriteRegisters(0, []uint16{1, 2, 3}), IllegalDataAddress)
	// A write refused as a whole changes nothing.
	if holding, _ := client.ReadRegisters(HoldingRegister, 0, 2); holding[0] != 0 {
		t.Fatalf("partial write applied: %v", holding)
	}
	other := client
	other.Unit = 2
	_, err = other.ReadBits(Coil, 0, 1)
	expectException(t, err, GatewayPathUnavailable)
	// An unknown function, a bad coil value, an oversized count.
	_, err = client.Exchange([]byte{0x17, 0, 0})
	expectException(t, err, IllegalFunction)
	_, err = client.Exchange([]byte{0x05, 0, 0, 0x12, 0x34})
	expectException(t, err, IllegalDataValue)
	_, err = client.ReadRegisters(HoldingRegister, 0, 200)
	expectException(t, err, IllegalDataValue)
}

func TestClosesConnectionsThatDoNotSpeakModbusAndOnClose(t *testing.T) {
	server, client := start(t, newMemory(), Options{MaxClients: 1})
	conn, err := net.Dial("tcp", client.Address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 16)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Read(buffer); err == nil {
		t.Fatal("a non-Modbus connection should be closed")
	}
	// The limit of clients holds; a closed server answers nothing.
	busy, _ := net.Dial("tcp", client.Address)
	defer busy.Close()
	time.Sleep(50 * time.Millisecond)
	if _, err := client.ReadBits(Coil, 0, 1); err == nil {
		t.Fatal("a second client should be refused while the first is connected")
	}
	busy.Close()
	server.Close()
	if _, err := client.ReadBits(Coil, 0, 1); err == nil {
		t.Fatal("a closed server should not answer")
	}
}
