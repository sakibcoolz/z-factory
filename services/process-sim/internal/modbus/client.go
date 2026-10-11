package modbus

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"
)

// Client is a minimal Modbus TCP client for tests and checks: one request per call.
type Client struct {
	Address string
	Unit    byte
	Timeout time.Duration
}

// Exchange sends a request PDU and returns the response PDU, or the exception it carries.
func (c Client) Exchange(pdu []byte) ([]byte, error) {
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 3 * time.Second
	}
	conn, err := net.DialTimeout("tcp", c.Address, timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	frame := make([]byte, mbapBytes+len(pdu))
	binary.BigEndian.PutUint16(frame[0:2], 1)
	binary.BigEndian.PutUint16(frame[4:6], uint16(len(pdu)+1))
	frame[6] = c.Unit
	copy(frame[mbapBytes:], pdu)
	if _, err := conn.Write(frame); err != nil {
		return nil, err
	}
	header := make([]byte, mbapBytes)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint16(header[4:6]))
	if length < 2 {
		return nil, fmt.Errorf("short response")
	}
	response := make([]byte, length-1)
	if _, err := io.ReadFull(conn, response); err != nil {
		return nil, err
	}
	if response[0]&0x80 != 0 && len(response) >= 2 {
		return nil, Exception(response[1])
	}
	return response, nil
}

func (c Client) read(function byte, address, count int) ([]byte, error) {
	pdu := []byte{function, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(pdu[1:3], uint16(address))
	binary.BigEndian.PutUint16(pdu[3:5], uint16(count))
	response, err := c.Exchange(pdu)
	if err != nil {
		return nil, err
	}
	return response[2:], nil
}

// ReadBits reads coils (function 1) or discrete inputs (function 2).
func (c Client) ReadBits(area Area, address, count int) ([]bool, error) {
	function := byte(0x01)
	if area == DiscreteInput {
		function = 0x02
	}
	data, err := c.read(function, address, count)
	if err != nil {
		return nil, err
	}
	bits := make([]bool, count)
	for index := range bits {
		bits[index] = data[index/8]&(1<<(index%8)) != 0
	}
	return bits, nil
}

// ReadRegisters reads holding (function 3) or input (function 4) registers.
func (c Client) ReadRegisters(area Area, address, count int) ([]uint16, error) {
	function := byte(0x03)
	if area == InputRegister {
		function = 0x04
	}
	data, err := c.read(function, address, count)
	if err != nil {
		return nil, err
	}
	words := make([]uint16, count)
	for index := range words {
		words[index] = binary.BigEndian.Uint16(data[2*index:])
	}
	return words, nil
}

// WriteCoil writes one coil (function 5).
func (c Client) WriteCoil(address int, value bool) error {
	pdu := []byte{0x05, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(pdu[1:3], uint16(address))
	if value {
		binary.BigEndian.PutUint16(pdu[3:5], 0xff00)
	}
	_, err := c.Exchange(pdu)
	return err
}

// WriteRegister writes one holding register (function 6).
func (c Client) WriteRegister(address int, value uint16) error {
	pdu := []byte{0x06, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(pdu[1:3], uint16(address))
	binary.BigEndian.PutUint16(pdu[3:5], value)
	_, err := c.Exchange(pdu)
	return err
}

// WriteCoils writes several coils (function 15).
func (c Client) WriteCoils(address int, values []bool) error {
	packed := packBits(values)
	pdu := make([]byte, 6+len(packed))
	pdu[0] = 0x0f
	binary.BigEndian.PutUint16(pdu[1:3], uint16(address))
	binary.BigEndian.PutUint16(pdu[3:5], uint16(len(values)))
	pdu[5] = byte(len(packed))
	copy(pdu[6:], packed)
	_, err := c.Exchange(pdu)
	return err
}

// WriteRegisters writes several holding registers (function 16).
func (c Client) WriteRegisters(address int, values []uint16) error {
	pdu := make([]byte, 6+2*len(values))
	pdu[0] = 0x10
	binary.BigEndian.PutUint16(pdu[1:3], uint16(address))
	binary.BigEndian.PutUint16(pdu[3:5], uint16(len(values)))
	pdu[5] = byte(2 * len(values))
	for index, value := range values {
		binary.BigEndian.PutUint16(pdu[6+2*index:], value)
	}
	_, err := c.Exchange(pdu)
	return err
}
