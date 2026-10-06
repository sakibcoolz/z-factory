// Package modbus is a small Modbus TCP client: the reads a worker polls with and the two
// writes a command may need (one coil, consecutive holding registers). One client holds
// one connection; it is not safe for concurrent use, and its owner (one PLC worker)
// serialises requests.
package modbus

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// Function codes used by the agent.
const (
	fnReadCoils          = 0x01
	fnReadDiscreteInputs = 0x02
	fnReadHolding        = 0x03
	fnReadInput          = 0x04
	fnWriteSingleCoil    = 0x05
	fnWriteMultipleRegs  = 0x10
)

// Limits of one request, from the Modbus specification.
const (
	MaxBits      = 2000
	MaxRegisters = 125
	MaxWriteRegs = 123
)

// ExceptionError is a Modbus exception response: the PLC answered and refused.
type ExceptionError struct {
	Function byte
	Code     byte
}

func (e *ExceptionError) Error() string {
	return fmt.Sprintf("modbus exception %d on function %d", e.Code, e.Function)
}

// IsException reports whether the PLC answered with an exception (the link itself is fine).
func IsException(err error) bool {
	var exception *ExceptionError
	return errors.As(err, &exception)
}

// Client is one connection to one PLC.
type Client struct {
	address string
	unitID  byte
	timeout time.Duration
	conn    net.Conn
	txID    uint16
}

// New returns a client that connects on first use.
func New(host string, port int, unitID int, timeout time.Duration) *Client {
	return &Client{address: net.JoinHostPort(host, strconv.Itoa(port)), unitID: byte(unitID), timeout: timeout}
}

// Connect opens the connection if it is not open.
func (c *Client) Connect(ctx context.Context) error {
	if c.conn != nil {
		return nil
	}
	dialer := net.Dialer{Timeout: c.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", c.address)
	if err != nil {
		return err
	}
	c.conn = conn
	return nil
}

// Close closes the connection; the next request opens a new one.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	err := c.conn.Close()
	c.conn = nil
	return err
}

// Connected reports whether a connection is open.
func (c *Client) Connected() bool { return c.conn != nil }

func (c *Client) request(ctx context.Context, function byte, payload []byte) ([]byte, error) {
	if err := c.Connect(ctx); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(c.timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = c.conn.SetDeadline(deadline)
	c.txID++
	frame := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint16(frame[0:], c.txID)
	binary.BigEndian.PutUint16(frame[4:], uint16(2+len(payload)))
	frame[6] = c.unitID
	frame[7] = function
	copy(frame[8:], payload)
	response, err := c.exchange(frame)
	if err != nil {
		// A broken exchange leaves the stream in an unknown state: start over next time.
		_ = c.Close()
		return nil, err
	}
	return response, nil
}

func (c *Client) exchange(frame []byte) ([]byte, error) {
	if _, err := c.conn.Write(frame); err != nil {
		return nil, err
	}
	header := make([]byte, 7)
	if _, err := io.ReadFull(c.conn, header); err != nil {
		return nil, err
	}
	if binary.BigEndian.Uint16(header[0:]) != binary.BigEndian.Uint16(frame[0:]) {
		return nil, errors.New("modbus: response to another transaction")
	}
	length := int(binary.BigEndian.Uint16(header[4:]))
	if length < 2 || length > 260 {
		return nil, fmt.Errorf("modbus: response length %d", length)
	}
	body := make([]byte, length-1)
	if _, err := io.ReadFull(c.conn, body); err != nil {
		return nil, err
	}
	function := frame[7]
	if body[0] == function|0x80 {
		if len(body) < 2 {
			return nil, errors.New("modbus: short exception")
		}
		return nil, &ExceptionError{Function: function, Code: body[1]}
	}
	if body[0] != function {
		return nil, fmt.Errorf("modbus: response to function %d, asked %d", body[0], function)
	}
	return body[1:], nil
}

func span(address, count int) []byte {
	payload := make([]byte, 4)
	binary.BigEndian.PutUint16(payload[0:], uint16(address))
	binary.BigEndian.PutUint16(payload[2:], uint16(count))
	return payload
}

func (c *Client) readBits(ctx context.Context, function byte, address, count int) ([]bool, error) {
	if count < 1 || count > MaxBits {
		return nil, fmt.Errorf("modbus: %d bits in one read", count)
	}
	data, err := c.request(ctx, function, span(address, count))
	if err != nil {
		return nil, err
	}
	if len(data) < 1 || int(data[0]) != (count+7)/8 || len(data) < 1+int(data[0]) {
		return nil, errors.New("modbus: bit response of the wrong size")
	}
	bits := make([]bool, count)
	for i := range bits {
		bits[i] = data[1+i/8]&(1<<(i%8)) != 0
	}
	return bits, nil
}

func (c *Client) readRegisters(ctx context.Context, function byte, address, count int) ([]uint16, error) {
	if count < 1 || count > MaxRegisters {
		return nil, fmt.Errorf("modbus: %d registers in one read", count)
	}
	data, err := c.request(ctx, function, span(address, count))
	if err != nil {
		return nil, err
	}
	if len(data) < 1 || int(data[0]) != 2*count || len(data) < 1+2*count {
		return nil, errors.New("modbus: register response of the wrong size")
	}
	words := make([]uint16, count)
	for i := range words {
		words[i] = binary.BigEndian.Uint16(data[1+2*i:])
	}
	return words, nil
}

// ReadBits reads coils or discrete inputs.
func (c *Client) ReadBits(ctx context.Context, area string, address, count int) ([]bool, error) {
	if area == "DISCRETE_INPUT" {
		return c.readBits(ctx, fnReadDiscreteInputs, address, count)
	}
	return c.readBits(ctx, fnReadCoils, address, count)
}

// ReadRegisters reads holding or input registers.
func (c *Client) ReadRegisters(ctx context.Context, area string, address, count int) ([]uint16, error) {
	if area == "INPUT_REGISTER" {
		return c.readRegisters(ctx, fnReadInput, address, count)
	}
	return c.readRegisters(ctx, fnReadHolding, address, count)
}

// WriteCoil writes one coil.
func (c *Client) WriteCoil(ctx context.Context, address int, value bool) error {
	payload := make([]byte, 4)
	binary.BigEndian.PutUint16(payload[0:], uint16(address))
	if value {
		payload[2] = 0xff
	}
	_, err := c.request(ctx, fnWriteSingleCoil, payload)
	return err
}

// WriteRegisters writes consecutive holding registers.
func (c *Client) WriteRegisters(ctx context.Context, address int, words []uint16) error {
	if len(words) < 1 || len(words) > MaxWriteRegs {
		return fmt.Errorf("modbus: %d registers in one write", len(words))
	}
	payload := make([]byte, 5+2*len(words))
	binary.BigEndian.PutUint16(payload[0:], uint16(address))
	binary.BigEndian.PutUint16(payload[2:], uint16(len(words)))
	payload[4] = byte(2 * len(words))
	for i, word := range words {
		binary.BigEndian.PutUint16(payload[5+2*i:], word)
	}
	_, err := c.request(ctx, fnWriteMultipleRegs, payload)
	return err
}
