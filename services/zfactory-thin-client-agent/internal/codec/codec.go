// Package codec converts typed engineering values to and from Modbus registers and coils,
// exactly as Z-Factory does (lib/protocols/modbus/codec.ts): the data type, word count,
// byte order, word order and scaling always come from the deployment, never from a guess.
//
// Engineering value = raw × scale + offset.
package codec

import (
	"errors"
	"fmt"
	"math"
)

// Encoding is how one mapping sits in the PLC's registers.
type Encoding struct {
	DataType  string
	ByteOrder string
	WordOrder string
	Scale     float64
	Offset    float64
}

// Words is how many 16-bit registers a data type takes; BOOL is one coil.
func Words(dataType string) int {
	switch dataType {
	case "INT32", "UINT32", "FLOAT32":
		return 2
	default:
		return 1
	}
}

// IsBool reports whether the data type is carried by a coil or discrete input.
func IsBool(dataType string) bool { return dataType == "BOOL" }

var rawRange = map[string][2]float64{
	"INT16":  {-32768, 32767},
	"UINT16": {0, 65535},
	"INT32":  {-2147483648, 2147483647},
	"UINT32": {0, 4294967295},
}

// Known reports whether the data type is one the codec carries.
func Known(dataType string) bool {
	_, ok := rawRange[dataType]
	return ok || dataType == "BOOL" || dataType == "FLOAT32"
}

func swap(word uint16) uint16 { return word<<8 | word>>8 }

// arrange orders words as they travel on the wire; it is its own inverse.
func arrange(words []uint16, e Encoding) []uint16 {
	out := append([]uint16(nil), words...)
	if e.WordOrder == "LOW_WORD_FIRST" && len(out) == 2 {
		out[0], out[1] = out[1], out[0]
	}
	if e.ByteOrder == "LITTLE_ENDIAN" {
		for i := range out {
			out[i] = swap(out[i])
		}
	}
	return out
}

func scale(e Encoding) float64 {
	if e.Scale == 0 {
		return 1
	}
	return e.Scale
}

// Decode turns registers into an engineering value.
func Decode(words []uint16, e Encoding) (float64, error) {
	if len(words) < Words(e.DataType) {
		return 0, fmt.Errorf("%s needs %d words, got %d", e.DataType, Words(e.DataType), len(words))
	}
	w := arrange(words[:Words(e.DataType)], e)
	var raw float64
	switch e.DataType {
	case "UINT16":
		raw = float64(w[0])
	case "INT16":
		raw = float64(int16(w[0]))
	case "UINT32":
		raw = float64(uint32(w[0])<<16 | uint32(w[1]))
	case "INT32":
		raw = float64(int32(uint32(w[0])<<16 | uint32(w[1])))
	case "FLOAT32":
		raw = float64(math.Float32frombits(uint32(w[0])<<16 | uint32(w[1])))
	default:
		return 0, fmt.Errorf("%s is not a register type", e.DataType)
	}
	return raw*scale(e) + e.Offset, nil
}

// ErrRange is returned when a value does not fit the mapping's type after scaling.
var ErrRange = errors.New("the value is outside the range of the mapping")

// Encode turns an engineering value into registers.
func Encode(value float64, e Encoding) ([]uint16, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, fmt.Errorf("%w: not a finite number", ErrRange)
	}
	raw := (value - e.Offset) / scale(e)
	var words []uint16
	switch e.DataType {
	case "FLOAT32":
		f := float32(raw)
		if math.IsInf(float64(f), 0) {
			return nil, fmt.Errorf("%w: does not fit a 32-bit float", ErrRange)
		}
		bits := math.Float32bits(f)
		words = []uint16{uint16(bits >> 16), uint16(bits)}
	case "INT16", "UINT16", "INT32", "UINT32":
		integer := math.Round(raw)
		limits := rawRange[e.DataType]
		if integer < limits[0] || integer > limits[1] {
			return nil, fmt.Errorf("%w: %s after scaling", ErrRange, e.DataType)
		}
		if Words(e.DataType) == 1 {
			words = []uint16{uint16(int64(integer))}
		} else {
			bits := uint32(int64(integer))
			words = []uint16{uint16(bits >> 16), uint16(bits)}
		}
	default:
		return nil, fmt.Errorf("%s is not a register type", e.DataType)
	}
	return arrange(words, e), nil
}

// Range is the engineering values a mapping can carry, after scale and offset.
func Range(e Encoding) (float64, float64) {
	if e.DataType == "BOOL" {
		return 0, 1
	}
	limits, ok := rawRange[e.DataType]
	if !ok {
		limits = [2]float64{-math.MaxFloat32, math.MaxFloat32}
	}
	a, b := limits[0]*scale(e)+e.Offset, limits[1]*scale(e)+e.Offset
	if a > b {
		a, b = b, a
	}
	return a, b
}
