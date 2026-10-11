// Package modbus is a Modbus TCP server for the catalog device runtime (TASK-1013): it
// speaks the protocol and nothing else. What a request may read or write is decided by
// the Handler it is given, by unit id; the server checks every length, count and
// function before the handler sees anything, and closes a connection that breaks the
// framing. Only the standard library is used.
package modbus

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// Area is a Modbus data area.
type Area string

const (
	Coil            Area = "COIL"
	DiscreteInput   Area = "DISCRETE_INPUT"
	HoldingRegister Area = "HOLDING_REGISTER"
	InputRegister   Area = "INPUT_REGISTER"
)

// Exception codes of the Modbus application protocol.
const (
	IllegalFunction        byte = 0x01
	IllegalDataAddress     byte = 0x02
	IllegalDataValue       byte = 0x03
	ServerDeviceFailure    byte = 0x04
	GatewayPathUnavailable byte = 0x0a
	GatewayTargetFailed    byte = 0x0b
)

// Exception is an error a handler returns to answer a request with a Modbus exception.
type Exception byte

func (e Exception) Error() string { return fmt.Sprintf("modbus exception %02x", byte(e)) }

// Handler answers requests for one unit id. Any error that is not an Exception answers
// SERVER_DEVICE_FAILURE.
type Handler interface {
	// ReadBits reads coils or discrete inputs.
	ReadBits(unit byte, area Area, address, count int) ([]bool, error)
	// ReadRegisters reads holding or input registers.
	ReadRegisters(unit byte, area Area, address, count int) ([]uint16, error)
	// WriteBits writes coils.
	WriteBits(unit byte, address int, values []bool) error
	// WriteRegisters writes holding registers.
	WriteRegisters(unit byte, address int, values []uint16) error
}

// Options bound a server.
type Options struct {
	// Further connections are refused; zero means 8.
	MaxClients int
	// A connection that sends nothing for this long is closed; zero means 2 minutes.
	Idle time.Duration
}

// Server is one listener with its connections.
type Server struct {
	listener net.Listener
	handler  Handler
	options  Options
	mu       sync.Mutex
	conns    map[net.Conn]struct{}
	closed   bool
	wg       sync.WaitGroup
}

const (
	mbapBytes        = 7
	maxPDUBytes      = 253
	maxReadBits      = 2000
	maxReadRegisters = 125
	maxWriteBits     = 1968
	maxWriteRegs     = 123
	addressSpace     = 65536
)

// Listen opens the server on the address ("127.0.0.1:0" for any free port) and serves
// until Close.
func Listen(address string, handler Handler, options Options) (*Server, error) {
	if options.MaxClients <= 0 {
		options.MaxClients = 8
	}
	if options.Idle <= 0 {
		options.Idle = 2 * time.Minute
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	server := &Server{listener: listener, handler: handler, options: options, conns: map[net.Conn]struct{}{}}
	server.wg.Add(1)
	go server.accept()
	return server, nil
}

// Addr is the address the server listens on.
func (s *Server) Addr() net.Addr { return s.listener.Addr() }

// Port is the TCP port the server listens on.
func (s *Server) Port() int {
	if addr, ok := s.listener.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

// Clients is the number of open connections.
func (s *Server) Clients() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.conns)
}

// Close stops listening and closes every connection. Safe to call more than once.
func (s *Server) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	_ = s.listener.Close()
	for conn := range s.conns {
		_ = conn.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Server) accept() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed || len(s.conns) >= s.options.MaxClients {
			s.mu.Unlock()
			_ = conn.Close()
			continue
		}
		s.conns[conn] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go s.serve(conn)
	}
}

func (s *Server) drop(conn net.Conn) {
	s.mu.Lock()
	delete(s.conns, conn)
	s.mu.Unlock()
	_ = conn.Close()
}

func (s *Server) serve(conn net.Conn) {
	defer s.wg.Done()
	defer s.drop(conn)
	header := make([]byte, mbapBytes)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(s.options.Idle))
		if _, err := io.ReadFull(conn, header); err != nil {
			return
		}
		protocol := binary.BigEndian.Uint16(header[2:4])
		length := int(binary.BigEndian.Uint16(header[4:6]))
		// Length counts the unit id and the PDU; a frame that is not Modbus TCP ends the connection.
		if protocol != 0 || length < 2 || length-1 > maxPDUBytes {
			return
		}
		pdu := make([]byte, length-1)
		if _, err := io.ReadFull(conn, pdu); err != nil {
			return
		}
		unit := header[6]
		response := s.answer(unit, pdu)
		frame := make([]byte, mbapBytes+len(response))
		copy(frame[0:4], header[0:4])
		binary.BigEndian.PutUint16(frame[4:6], uint16(len(response)+1))
		frame[6] = unit
		copy(frame[mbapBytes:], response)
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := conn.Write(frame); err != nil {
			return
		}
	}
}

func exception(function byte, code byte) []byte { return []byte{function | 0x80, code} }

func toException(function byte, err error) []byte {
	var code Exception
	if errors.As(err, &code) {
		return exception(function, byte(code))
	}
	return exception(function, ServerDeviceFailure)
}

// answer builds the response PDU of a request PDU.
func (s *Server) answer(unit byte, pdu []byte) []byte {
	if len(pdu) == 0 {
		return exception(0, IllegalFunction)
	}
	function := pdu[0]
	data := pdu[1:]
	switch function {
	case 0x01, 0x02:
		if len(data) != 4 {
			return exception(function, IllegalDataValue)
		}
		address, count := int(binary.BigEndian.Uint16(data[0:2])), int(binary.BigEndian.Uint16(data[2:4]))
		if count < 1 || count > maxReadBits || address+count > addressSpace {
			return exception(function, IllegalDataValue)
		}
		area := Coil
		if function == 0x02 {
			area = DiscreteInput
		}
		bits, err := s.handler.ReadBits(unit, area, address, count)
		if err != nil {
			return toException(function, err)
		}
		if len(bits) != count {
			return exception(function, ServerDeviceFailure)
		}
		packed := packBits(bits)
		return append([]byte{function, byte(len(packed))}, packed...)
	case 0x03, 0x04:
		if len(data) != 4 {
			return exception(function, IllegalDataValue)
		}
		address, count := int(binary.BigEndian.Uint16(data[0:2])), int(binary.BigEndian.Uint16(data[2:4]))
		if count < 1 || count > maxReadRegisters || address+count > addressSpace {
			return exception(function, IllegalDataValue)
		}
		area := HoldingRegister
		if function == 0x04 {
			area = InputRegister
		}
		words, err := s.handler.ReadRegisters(unit, area, address, count)
		if err != nil {
			return toException(function, err)
		}
		if len(words) != count {
			return exception(function, ServerDeviceFailure)
		}
		response := make([]byte, 2+2*count)
		response[0], response[1] = function, byte(2*count)
		for index, word := range words {
			binary.BigEndian.PutUint16(response[2+2*index:], word)
		}
		return response
	case 0x05:
		if len(data) != 4 {
			return exception(function, IllegalDataValue)
		}
		address, value := int(binary.BigEndian.Uint16(data[0:2])), binary.BigEndian.Uint16(data[2:4])
		if value != 0x0000 && value != 0xff00 {
			return exception(function, IllegalDataValue)
		}
		if err := s.handler.WriteBits(unit, address, []bool{value == 0xff00}); err != nil {
			return toException(function, err)
		}
		return append([]byte{function}, data...)
	case 0x06:
		if len(data) != 4 {
			return exception(function, IllegalDataValue)
		}
		address, value := int(binary.BigEndian.Uint16(data[0:2])), binary.BigEndian.Uint16(data[2:4])
		if err := s.handler.WriteRegisters(unit, address, []uint16{value}); err != nil {
			return toException(function, err)
		}
		return append([]byte{function}, data...)
	case 0x0f:
		if len(data) < 5 {
			return exception(function, IllegalDataValue)
		}
		address, count, byteCount := int(binary.BigEndian.Uint16(data[0:2])), int(binary.BigEndian.Uint16(data[2:4])), int(data[4])
		if count < 1 || count > maxWriteBits || address+count > addressSpace || byteCount != (count+7)/8 || len(data) != 5+byteCount {
			return exception(function, IllegalDataValue)
		}
		values := make([]bool, count)
		for index := range values {
			values[index] = data[5+index/8]&(1<<(index%8)) != 0
		}
		if err := s.handler.WriteBits(unit, address, values); err != nil {
			return toException(function, err)
		}
		return append([]byte{function}, data[0:4]...)
	case 0x10:
		if len(data) < 5 {
			return exception(function, IllegalDataValue)
		}
		address, count, byteCount := int(binary.BigEndian.Uint16(data[0:2])), int(binary.BigEndian.Uint16(data[2:4])), int(data[4])
		if count < 1 || count > maxWriteRegs || address+count > addressSpace || byteCount != 2*count || len(data) != 5+byteCount {
			return exception(function, IllegalDataValue)
		}
		values := make([]uint16, count)
		for index := range values {
			values[index] = binary.BigEndian.Uint16(data[5+2*index:])
		}
		if err := s.handler.WriteRegisters(unit, address, values); err != nil {
			return toException(function, err)
		}
		return append([]byte{function}, data[0:4]...)
	default:
		return exception(function, IllegalFunction)
	}
}

func packBits(values []bool) []byte {
	packed := make([]byte, (len(values)+7)/8)
	for index, value := range values {
		if value {
			packed[index/8] |= 1 << (index % 8)
		}
	}
	return packed
}
