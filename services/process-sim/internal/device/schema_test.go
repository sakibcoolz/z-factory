package device

import (
	"encoding/json"
	"math"
	"testing"
)

// The parameter schema a profile describes is exactly what Configure enforces: the
// defaults pass, every bound is where the schema says, every choice and kind is checked,
// and the defaults body names the same parameters (TASK-1010).
func TestParameterSchemasAreWhatConfigureEnforces(t *testing.T) {
	for _, key := range Profiles() {
		if key == "BROKEN" {
			continue
		}
		description, err := Describe(key)
		if err != nil {
			t.Fatal(err)
		}
		var defaults map[string]any
		if err := json.Unmarshal(description.Parameters, &defaults); err != nil {
			t.Fatalf("%s: defaults %v", key, err)
		}
		configure := func(overrides map[string]any) error {
			behavior, _ := New(key)
			body := map[string]any{}
			for name, value := range defaults {
				body[name] = value
			}
			for name, value := range overrides {
				body[name] = value
			}
			raw, _ := json.Marshal(body)
			return behavior.Configure(raw)
		}
		if err := configure(nil); err != nil {
			t.Fatalf("%s: defaults refused: %v", key, err)
		}
		if len(description.ParameterSchema) == 0 {
			t.Fatalf("%s: no parameter schema", key)
		}
		inSchema := map[string]bool{}
		for _, spec := range description.ParameterSchema {
			inSchema[spec.Key] = true
			if spec.Label == "" || spec.Role == "" {
				t.Fatalf("%s.%s: incomplete spec %+v", key, spec.Key, spec)
			}
			// The defaults body and the schema name the same parameters.
			_, inDefaults := defaults[spec.Key]
			if (spec.Default != nil) != inDefaults {
				t.Fatalf("%s.%s: default %v in schema, %v in the defaults body", key, spec.Key, spec.Default, defaults[spec.Key])
			}
			switch spec.Kind {
			case "NUMBER":
				checkNumberBounds(t, key, spec, configure)
			case "CHOICE":
				if len(spec.Choices) == 0 || spec.Default == nil {
					t.Fatalf("%s.%s: a choice needs choices and a default", key, spec.Key)
				}
				for _, choice := range spec.Choices {
					if err := configure(map[string]any{spec.Key: choice}); err != nil {
						t.Fatalf("%s.%s = %s refused: %v", key, spec.Key, choice, err)
					}
				}
				if err := configure(map[string]any{spec.Key: "NOT_A_CHOICE"}); err == nil {
					t.Fatalf("%s.%s accepted a value outside its choices", key, spec.Key)
				}
			case "STRUCTURED":
				if len(spec.Kinds) == 0 || spec.Default == nil {
					t.Fatalf("%s.%s: a structure needs kinds and a default", key, spec.Key)
				}
				if err := configure(map[string]any{spec.Key: map[string]any{"kind": "NOT_A_KIND"}}); err == nil {
					t.Fatalf("%s.%s accepted an unknown kind", key, spec.Key)
				}
			default:
				t.Fatalf("%s.%s: unknown kind %s", key, spec.Key, spec.Kind)
			}
		}
		for name := range defaults {
			if !inSchema[name] {
				t.Fatalf("%s: the defaults body has %s, the schema does not", key, name)
			}
		}
		// A parameter the schema does not name is refused.
		if err := configure(map[string]any{"notAParameter": 1}); err == nil {
			t.Fatalf("%s accepted an unknown parameter", key)
		}
	}
}

func checkNumberBounds(t *testing.T, key string, spec ParameterSpec, configure func(map[string]any) error) {
	t.Helper()
	const step = 1e-6
	if spec.Default != nil {
		value, ok := spec.Default.(float64)
		if !ok {
			t.Fatalf("%s.%s: default %v is not a number", key, spec.Key, spec.Default)
		}
		if spec.Min != nil && (value < *spec.Min || (!spec.MinInclusive && value == *spec.Min)) {
			t.Fatalf("%s.%s: default %g below its minimum", key, spec.Key, value)
		}
		if spec.Max != nil && (value > *spec.Max || (!spec.MaxInclusive && value == *spec.Max)) {
			t.Fatalf("%s.%s: default %g above its maximum", key, spec.Key, value)
		}
	}
	if spec.Min != nil {
		if err := configure(map[string]any{spec.Key: *spec.Min - step}); err == nil {
			t.Fatalf("%s.%s accepted a value below its minimum", key, spec.Key)
		}
		if err := configure(map[string]any{spec.Key: *spec.Min}); (err == nil) != spec.MinInclusive {
			t.Fatalf("%s.%s at its minimum: inclusive %v, err %v", key, spec.Key, spec.MinInclusive, err)
		}
	}
	if spec.Max != nil {
		if err := configure(map[string]any{spec.Key: *spec.Max + step}); err == nil {
			t.Fatalf("%s.%s accepted a value above its maximum", key, spec.Key)
		}
		if err := configure(map[string]any{spec.Key: *spec.Max}); (err == nil) != spec.MaxInclusive {
			t.Fatalf("%s.%s at its maximum: inclusive %v, err %v", key, spec.Key, spec.MaxInclusive, err)
		}
	}
	// Within the bounds, a value is accepted.
	inside := 1.0
	if spec.Min != nil {
		inside = *spec.Min + 1
	}
	if spec.Max != nil && inside > *spec.Max {
		inside = *spec.Max - math.Min(1, (*spec.Max-*spec.Min)/2)
	}
	if err := configure(map[string]any{spec.Key: inside}); err != nil {
		t.Fatalf("%s.%s = %g refused: %v", key, spec.Key, inside, err)
	}
}
