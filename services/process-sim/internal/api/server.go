// Package api is the HTTP interface of the service: a small JSON API for Z-Factory's
// server, behind a bearer token. It is an internal runtime component (docs/security.md):
// nothing in it is meant for a browser, and every request but the health check is
// authenticated.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/engine"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/runtime"
)

// Version of the service, set by the build.
var Version = "dev"

// Server wires the handlers to the process-module engine and the catalog device runtime.
type Server struct {
	engine  *engine.Engine
	devices *runtime.Runtime
	token   string
	log     *slog.Logger
	started time.Time
}

// New builds the server. The token must not be empty: an unauthenticated service does not start.
func New(e *engine.Engine, devices *runtime.Runtime, token string, log *slog.Logger) (*Server, error) {
	if len(token) < 16 {
		return nil, errors.New("PROCESS_SIM_TOKEN must be set and at least 16 characters long")
	}
	return &Server{engine: e, devices: devices, token: token, log: log, started: time.Now()}, nil
}

// Handler returns the routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	auth := s.authenticated
	mux.Handle("GET /metrics", auth(s.metrics))
	mux.Handle("GET /v1/instances", auth(s.list))
	mux.Handle("PUT /v1/instances/{id}", auth(s.load))
	mux.Handle("GET /v1/instances/{id}", auth(s.inspect))
	mux.Handle("DELETE /v1/instances/{id}", auth(s.unload))
	mux.Handle("POST /v1/instances/{id}/start", auth(s.lifecycle(s.engine.Start)))
	mux.Handle("POST /v1/instances/{id}/stop", auth(s.lifecycle(s.engine.Stop)))
	mux.Handle("POST /v1/instances/{id}/reset", auth(s.lifecycle(s.engine.Reset)))
	mux.Handle("POST /v1/instances/{id}/step", auth(s.step))
	mux.Handle("PUT /v1/instances/{id}/inputs", auth(s.inputs))
	mux.Handle("GET /v1/instances/{id}/events", auth(s.events))
	mux.Handle("GET /v1/instances/{id}/overrides", auth(s.listOverrides))
	mux.Handle("PUT /v1/instances/{id}/overrides/{signal}", auth(s.setOverride))
	mux.Handle("DELETE /v1/instances/{id}/overrides/{signal}", auth(s.clearOverride))
	s.deviceRoutes(mux, auth)
	return s.logged(mux)
}

type problem struct {
	Error string `json:"error"`
	Code  string `json:"code"`
	// The rule a refusal names, where the device runtime knows one (TASK-1007).
	Rule string `json:"rule,omitempty"`
}

func (s *Server) authenticated(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+s.token {
			writeJSON(w, http.StatusUnauthorized, problem{Error: "a bearer token is required", Code: "unauthorized"})
			return
		}
		next(w, r)
	})
}

func (s *Server) logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		s.log.Info("request", "method", r.Method, "path", r.URL.Path, "status", recorder.status, "durationMicros", time.Since(started).Microseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	metrics := s.engine.Metrics()
	devices := s.devices.Metrics()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":                "ok",
		"version":               Version,
		"contractVersion":       engine.ContractVersion,
		"deviceContractVersion": device.ContractVersion,
		"uptimeS":               int64(time.Since(s.started).Seconds()),
		"instances":             metrics.Instances,
		"modelTypes":            metrics.ModelTypes,
		"factories":             devices.Factories,
		"devices":               devices.Devices,
		"profiles":              devices.Profiles,
		"registerMaps":          device.RegisterMaps(),
	})
}

// metrics: the process-module counters as before, and the device runtime's under `devices`.
func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	engineMetrics := s.engine.Metrics()
	writeJSON(w, http.StatusOK, map[string]any{
		"instances":      engineMetrics.Instances,
		"byStatus":       engineMetrics.ByStatus,
		"ticksTotal":     engineMetrics.TicksTotal,
		"lastTickMicros": engineMetrics.LastTickMicros,
		"modelTypes":     engineMetrics.ModelTypes,
		"devices":        s.devices.Metrics(),
	})
}

func (s *Server) list(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"instances": s.engine.List()})
}

func (s *Server) load(w http.ResponseWriter, r *http.Request) {
	var config engine.Config
	if err := decode(w, r, &config); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	if config.InstanceID == "" {
		config.InstanceID = r.PathValue("id")
	}
	if config.InstanceID != r.PathValue("id") {
		writeJSON(w, http.StatusBadRequest, problem{Error: "instanceId does not match the path", Code: "bad-request"})
		return
	}
	snapshot, err := s.engine.Load(config)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) inspect(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.engine.Inspect(r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) unload(w http.ResponseWriter, r *http.Request) {
	if err := s.engine.Unload(r.PathValue("id")); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) lifecycle(op func(id string) (engine.Snapshot, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		snapshot, err := op(r.PathValue("id"))
		if err != nil {
			s.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	}
}

func (s *Server) step(w http.ResponseWriter, r *http.Request) {
	ticks := 1
	if raw := r.URL.Query().Get("ticks"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, problem{Error: "ticks must be a whole number", Code: "bad-request"})
			return
		}
		ticks = parsed
	}
	snapshot, err := s.engine.Step(r.PathValue("id"), ticks)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) inputs(w http.ResponseWriter, r *http.Request) {
	var values map[string]float64
	if err := decode(w, r, &values); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	snapshot, err := s.engine.SetInputs(r.PathValue("id"), values)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	var after uint64
	if raw := r.URL.Query().Get("after"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, problem{Error: "after must be a sequence number", Code: "bad-request"})
			return
		}
		after = parsed
	}
	events, err := s.engine.Events(r.PathValue("id"), after)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) listOverrides(w http.ResponseWriter, r *http.Request) {
	states, err := s.engine.Overrides(r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"signals": states})
}

func (s *Server) setOverride(w http.ResponseWriter, r *http.Request) {
	var request engine.OverrideRequest
	if err := decode(w, r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, problem{Error: err.Error(), Code: "bad-request"})
		return
	}
	state, err := s.engine.SetOverride(r.PathValue("id"), r.PathValue("signal"), request)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// clearOverride returns a measured output to AUTO; `?source=` names who asked.
func (s *Server) clearOverride(w http.ResponseWriter, r *http.Request) {
	state, err := s.engine.ClearOverride(r.PathValue("id"), r.PathValue("signal"), r.URL.Query().Get("source"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	if status, body, ok := deviceProblem(err); ok {
		writeJSON(w, status, body)
		return
	}
	var configErr *engine.ConfigError
	var stateErr *engine.StateError
	switch {
	case errors.Is(err, engine.ErrNotFound):
		writeJSON(w, http.StatusNotFound, problem{Error: err.Error(), Code: "not-found"})
	case errors.As(err, &configErr):
		writeJSON(w, http.StatusUnprocessableEntity, problem{Error: err.Error(), Code: "invalid-configuration"})
	case errors.As(err, &stateErr):
		writeJSON(w, http.StatusConflict, problem{Error: err.Error(), Code: "wrong-state"})
	default:
		s.log.Error("request failed", "error", err.Error())
		writeJSON(w, http.StatusInternalServerError, problem{Error: "the service could not do that", Code: "internal"})
	}
}

// decode reads a JSON body of at most 1 MiB and refuses unknown fields.
func decode(w http.ResponseWriter, r *http.Request, into any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return errors.New("the body is not the JSON this endpoint takes: " + err.Error())
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
