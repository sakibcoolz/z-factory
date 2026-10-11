package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/runtime"
)

// The catalog device runtime's routes (TASK-1009): factories of devices, beside the
// process-module instances. Additive: nothing of /v1/instances changes.
func (s *Server) deviceRoutes(mux *http.ServeMux, auth func(http.HandlerFunc) http.Handler) {
	mux.Handle("GET /v1/profiles", auth(s.profiles))
	mux.Handle("GET /v1/profiles/{key}", auth(s.profile))
	mux.Handle("GET /v1/factories", auth(s.listFactories))
	mux.Handle("PUT /v1/factories/{factoryId}", auth(s.loadFactory))
	mux.Handle("GET /v1/factories/{factoryId}", auth(s.inspectFactory))
	mux.Handle("DELETE /v1/factories/{factoryId}", auth(s.unloadFactory))
	mux.Handle("POST /v1/factories/{factoryId}/start", auth(s.factoryLifecycle(s.devices.Start)))
	mux.Handle("POST /v1/factories/{factoryId}/stop", auth(s.factoryLifecycle(s.devices.Stop)))
	mux.Handle("POST /v1/factories/{factoryId}/reset", auth(s.factoryLifecycle(s.devices.Reset)))
	mux.Handle("POST /v1/factories/{factoryId}/step", auth(s.stepFactory))
	mux.Handle("GET /v1/factories/{factoryId}/events", auth(s.factoryEvents))
	mux.Handle("PUT /v1/factories/{factoryId}/devices/{deviceId}", auth(s.upsertDevice))
	mux.Handle("GET /v1/factories/{factoryId}/devices/{deviceId}", auth(s.inspectDevice))
	mux.Handle("DELETE /v1/factories/{factoryId}/devices/{deviceId}", auth(s.removeDevice))
	mux.Handle("PUT /v1/factories/{factoryId}/devices/{deviceId}/inputs", auth(s.deviceInputs))
	mux.Handle("POST /v1/factories/{factoryId}/devices/{deviceId}/faults/{code}", auth(s.deviceFault(s.devices.InjectFault)))
	mux.Handle("DELETE /v1/factories/{factoryId}/devices/{deviceId}/faults/{code}", auth(s.deviceFault(s.devices.ClearFault)))
	mux.Handle("POST /v1/factories/{factoryId}/devices/{deviceId}/reset", auth(s.resetDevice))
	mux.Handle("PUT /v1/factories/{factoryId}/devices/{deviceId}/force", auth(s.forceDevice))
	mux.Handle("DELETE /v1/factories/{factoryId}/devices/{deviceId}/force", auth(s.unforceDevice))
}

func (s *Server) profiles(w http.ResponseWriter, _ *http.Request) {
	descriptions := make([]device.Description, 0)
	for _, key := range device.Profiles() {
		description, err := device.Describe(key)
		if err == nil {
			descriptions = append(descriptions, description)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"contractVersion": device.ContractVersion, "profiles": descriptions})
}

func (s *Server) profile(w http.ResponseWriter, r *http.Request) {
	description, err := device.Describe(r.PathValue("key"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, problem{Error: err.Error(), Code: "not-found"})
		return
	}
	writeJSON(w, http.StatusOK, description)
}

func (s *Server) listFactories(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"factories": s.devices.List()})
}

func (s *Server) loadFactory(w http.ResponseWriter, r *http.Request) {
	var config runtime.Config
	if err := decode(w, r, &config); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	if config.FactoryID == "" {
		config.FactoryID = r.PathValue("factoryId")
	}
	if config.FactoryID != r.PathValue("factoryId") {
		writeJSON(w, http.StatusBadRequest, problem{Error: "factoryId does not match the path", Code: "bad-request"})
		return
	}
	snapshot, err := s.devices.Load(config)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) inspectFactory(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.devices.Inspect(r.PathValue("factoryId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) unloadFactory(w http.ResponseWriter, r *http.Request) {
	if err := s.devices.Unload(r.PathValue("factoryId")); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) factoryLifecycle(op func(id string) (runtime.Snapshot, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		snapshot, err := op(r.PathValue("factoryId"))
		if err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	}
}

func (s *Server) stepFactory(w http.ResponseWriter, r *http.Request) {
	ticks := 1
	if raw := r.URL.Query().Get("ticks"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, problem{Error: "ticks must be a whole number", Code: "bad-request"})
			return
		}
		ticks = parsed
	}
	snapshot, err := s.devices.Step(r.PathValue("factoryId"), ticks)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) factoryEvents(w http.ResponseWriter, r *http.Request) {
	var after uint64
	if raw := r.URL.Query().Get("after"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, problem{Error: "after must be a sequence number", Code: "bad-request"})
			return
		}
		after = parsed
	}
	events, err := s.devices.Events(r.PathValue("factoryId"), after)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) upsertDevice(w http.ResponseWriter, r *http.Request) {
	var config device.Config
	if err := decode(w, r, &config); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	if config.DeviceID == "" {
		config.DeviceID = r.PathValue("deviceId")
	}
	if config.DeviceID != r.PathValue("deviceId") {
		writeJSON(w, http.StatusBadRequest, problem{Error: "deviceId does not match the path", Code: "bad-request"})
		return
	}
	snapshot, err := s.devices.Upsert(r.PathValue("factoryId"), config)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) inspectDevice(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.devices.Device(r.PathValue("factoryId"), r.PathValue("deviceId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) removeDevice(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.devices.RemoveDevice(r.PathValue("factoryId"), r.PathValue("deviceId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) deviceInputs(w http.ResponseWriter, r *http.Request) {
	var values device.Values
	if err := decode(w, r, &values); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	snapshot, err := s.devices.SetInputs(r.PathValue("factoryId"), r.PathValue("deviceId"), values)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) deviceFault(op func(factoryID, deviceID, code string) (device.Snapshot, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		snapshot, err := op(r.PathValue("factoryId"), r.PathValue("deviceId"), r.PathValue("code"))
		if err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	}
}

func (s *Server) resetDevice(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.devices.ResetDevice(r.PathValue("factoryId"), r.PathValue("deviceId"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) forceDevice(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Value *float64 `json:"value"`
	}
	if err := decode(w, r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	if request.Value == nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: "a forced value is required; DELETE releases it", Code: "bad-request"})
		return
	}
	snapshot, err := s.devices.Force(r.PathValue("factoryId"), r.PathValue("deviceId"), request.Value)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) unforceDevice(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.devices.Force(r.PathValue("factoryId"), r.PathValue("deviceId"), nil)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// deviceProblem maps the device runtime's errors to a response; false for other errors.
func deviceProblem(err error) (int, problem, bool) {
	var configErr *device.ConfigError
	var stateErr *device.StateError
	switch {
	case errors.Is(err, runtime.ErrNotFound), errors.Is(err, device.ErrNotFound):
		return http.StatusNotFound, problem{Error: err.Error(), Code: "not-found"}, true
	case errors.As(err, &configErr):
		return http.StatusUnprocessableEntity, problem{Error: "invalid configuration: " + configErr.Reason, Code: "invalid-configuration", Rule: configErr.Rule}, true
	case errors.As(err, &stateErr):
		return http.StatusConflict, problem{Error: stateErr.Reason, Code: "wrong-state", Rule: stateErr.Rule}, true
	}
	return 0, problem{}, false
}
