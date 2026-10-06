// Package modbustest is an in-memory Modbus TCP server that stands in for a PLC in tests:
// coils, discrete inputs, holding and input registers, a request log, and switches to make
// it slow, refuse a range or go away.
package modbustest

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

// Server is a fake PLC listening on 127.0.0.1.
type Server struct {
	mu       sync.Mutex
	listener net.Listener
	conns    map[net.Conn]bool
	closed   bool

	Coils    [65536]bool
	Discrete [65536]bool
	Holding  [65536]uint16
	Input    [65536]uint16

	delay    time.Duration
	refuse   map[byte]bool
	requests int
	writes   []string
}

// Start listens on a free local port.
func Start() (*Server, error) { return StartAt("127.0.0.1", 0) }

// StartAt listens on the given address, e.g. to bring a PLC back where it was.
func StartAt(host string, port int) (*Server, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	server := &Server{listener: listener, conns: map[net.Conn]bool{}, refuse: map[byte]bool{}}
	go server.accept()
	return server, nil
}

// Addr returns host and port.
func (s *Server) Addr() (string, int) {
	address := s.listener.Addr().(*net.TCPAddr)
	return address.IP.String(), address.Port
}

// Close stops the server and drops every connection: the PLC is gone.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	conns := s.conns
	s.conns = map[net.Conn]bool{}
	s.mu.Unlock()
	_ = s.listener.Close()
	for conn := range conns {
		_ = conn.Close()
	}
}

// SetDelay makes every answer wait.
func (s *Server) SetDelay(delay time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.delay = delay
}

// Refuse makes the server answer a function code with an exception.
func (s *Server) Refuse(function byte, refuse bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refuse[function] = refuse
}

// Requests counts the requests answered so far.
func (s *Server) Requests() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

// Writes lists the writes received, as "coil 3=true" or "registers 10=[1 2]".
func (s *Server) Writes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.writes...)
}

// SetHolding sets holding registers under the lock.
func (s *Server) SetHolding(address int, words ...uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy(s.Holding[address:], words)
}

// SetCoil sets a coil under the lock.
func (s *Server) SetCoil(address int, value bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Coils[address] = value
}

// HoldingAt reads holding registers under the lock.
func (s *Server) HoldingAt(address, count int) []uint16 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]uint16(nil), s.Holding[address:address+count]...)
}

// CoilAt reads a coil under the lock.
func (s *Server) CoilAt(address int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Coils[address]
}

func (s *Server) accept() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = conn.Close()
			return
		}
		s.conns[conn] = true
		s.mu.Unlock()
		go s.serve(conn)
	}
}

func (s *Server) serve(conn net.Conn) {
	defer func() {
		_ = conn.Close()
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
	}()
	header := make([]byte, 7)
	for {
		if _, err := io.ReadFull(conn, header); err != nil {
			return
		}
		length := int(binary.BigEndian.Uint16(header[4:]))
		if length < 2 || length > 260 {
			return
		}
		body := make([]byte, length-1)
		if _, err := io.ReadFull(conn, body); err != nil {
			return
		}
		s.mu.Lock()
		delay := s.delay
		s.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		answer := s.handle(body[0], body[1:])
		frame := make([]byte, 7+len(answer))
		copy(frame, header[:4])
		binary.BigEndian.PutUint16(frame[4:], uint16(1+len(answer)))
		frame[6] = header[6]
		copy(frame[7:], answer)
		if _, err := conn.Write(frame); err != nil {
			return
		}
	}
}

var errRange = errors.New("range")

func (s *Server) handle(function byte, data []byte) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests++
	exception := func(code byte) []byte { return []byte{function | 0x80, code} }
	if s.refuse[function] {
		return exception(2)
	}
	if len(data) < 4 {
		return exception(3)
	}
	address := int(binary.BigEndian.Uint16(data[0:]))
	count := int(binary.BigEndian.Uint16(data[2:]))
	bits := func(source *[65536]bool) ([]byte, error) {
		if count < 1 || count > 2000 || address+count > 65536 {
			return nil, errRange
		}
		out := []byte{function, byte((count + 7) / 8)}
		packed := make([]byte, (count+7)/8)
		for i := 0; i < count; i++ {
			if source[address+i] {
				packed[i/8] |= 1 << (i % 8)
			}
		}
		return append(out, packed...), nil
	}
	registers := func(source *[65536]uint16) ([]byte, error) {
		if count < 1 || count > 125 || address+count > 65536 {
			return nil, errRange
		}
		out := []byte{function, byte(2 * count)}
		for i := 0; i < count; i++ {
			out = binary.BigEndian.AppendUint16(out, source[address+i])
		}
		return out, nil
	}
	var answer []byte
	var err error
	switch function {
	case 0x01:
		answer, err = bits(&s.Coils)
	case 0x02:
		answer, err = bits(&s.Discrete)
	case 0x03:
		answer, err = registers(&s.Holding)
	case 0x04:
		answer, err = registers(&s.Input)
	case 0x05:
		s.Coils[address] = data[2] == 0xff
		s.writes = append(s.writes, "coil "+strconv.Itoa(address)+"="+strconv.FormatBool(s.Coils[address]))
		answer = append([]byte{function}, data[:4]...)
	case 0x10:
		if len(data) < 5+2*count || address+count > 65536 {
			return exception(3)
		}
		words := make([]uint16, count)
		for i := range words {
			words[i] = binary.BigEndian.Uint16(data[5+2*i:])
			s.Holding[address+i] = words[i]
		}
		s.writes = append(s.writes, "registers "+strconv.Itoa(address)+"="+wordsText(words))
		answer = append([]byte{function}, data[:4]...)
	default:
		return exception(1)
	}
	if err != nil {
		return exception(2)
	}
	return answer
}

func wordsText(words []uint16) string { return fmt.Sprint(words) }
