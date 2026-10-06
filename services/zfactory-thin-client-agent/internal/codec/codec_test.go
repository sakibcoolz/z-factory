package codec

import (
	"errors"
	"math"
	"testing"
)

func TestDecodeMatchesZFactory(t *testing.T) {
	cases := []struct {
		name  string
		words []uint16
		e     Encoding
		want  float64
	}{
		{"uint16", []uint16{65535}, Encoding{DataType: "UINT16"}, 65535},
		{"int16 negative", []uint16{0xffff}, Encoding{DataType: "INT16"}, -1},
		{"int16 scaled", []uint16{425}, Encoding{DataType: "INT16", Scale: 0.1}, 42.5},
		{"int16 offset", []uint16{100}, Encoding{DataType: "INT16", Scale: 2, Offset: -50}, 150},
		{"uint32 high first", []uint16{0x0001, 0x0002}, Encoding{DataType: "UINT32"}, 65538},
		{"uint32 low first", []uint16{0x0002, 0x0001}, Encoding{DataType: "UINT32", WordOrder: "LOW_WORD_FIRST"}, 65538},
		{"int32 negative", []uint16{0xffff, 0xfffe}, Encoding{DataType: "INT32"}, -2},
		{"little endian bytes", []uint16{0x3412}, Encoding{DataType: "UINT16", ByteOrder: "LITTLE_ENDIAN"}, 0x1234},
		{"float32", []uint16{0x4020, 0x0000}, Encoding{DataType: "FLOAT32"}, 2.5},
	}
	for _, c := range cases {
		got, err := Decode(c.words, c.e)
		if err != nil || got != c.want {
			t.Errorf("%s: got %v, %v; want %v", c.name, got, err, c.want)
		}
	}
	if _, err := Decode([]uint16{1}, Encoding{DataType: "FLOAT32"}); err == nil {
		t.Error("a float from one word must fail")
	}
}

func TestEncodeRoundTripsAndRefusesWhatDoesNotFit(t *testing.T) {
	encodings := []Encoding{
		{DataType: "INT16", Scale: 0.1},
		{DataType: "UINT16"},
		{DataType: "INT32", WordOrder: "LOW_WORD_FIRST"},
		{DataType: "UINT32", ByteOrder: "LITTLE_ENDIAN"},
		{DataType: "FLOAT32", WordOrder: "LOW_WORD_FIRST", ByteOrder: "LITTLE_ENDIAN"},
	}
	for _, e := range encodings {
		words, err := Encode(42.5, e)
		if e.DataType == "UINT16" || e.DataType == "INT32" || e.DataType == "UINT32" {
			words, err = Encode(42, e)
		}
		if err != nil {
			t.Fatalf("%v: %v", e, err)
		}
		got, err := Decode(words, e)
		want := 42.5
		if e.DataType == "UINT16" || e.DataType == "INT32" || e.DataType == "UINT32" {
			want = 42
		}
		if err != nil || math.Abs(got-want) > 1e-9 {
			t.Errorf("%v: round trip %v, %v", e, got, err)
		}
	}
	for _, refused := range []struct {
		value float64
		e     Encoding
	}{
		{3276.8, Encoding{DataType: "INT16", Scale: 0.1}},
		{-1, Encoding{DataType: "UINT16"}},
		{math.NaN(), Encoding{DataType: "FLOAT32"}},
		{1e39, Encoding{DataType: "FLOAT32"}},
	} {
		if _, err := Encode(refused.value, refused.e); !errors.Is(err, ErrRange) {
			t.Errorf("%v as %v: want a range error, got %v", refused.value, refused.e, err)
		}
	}
	if low, high := Range(Encoding{DataType: "INT16", Scale: 0.1}); math.Abs(low+3276.8) > 1e-9 || math.Abs(high-3276.7) > 1e-9 {
		t.Errorf("range %v..%v", low, high)
	}
}
