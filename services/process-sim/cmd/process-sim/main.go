// Command process-sim runs the Z-Factory process simulation service (ADR-0008): a
// deterministic tick loop for many process-module instances, behind a token-protected
// JSON API that only Z-Factory's server talks to.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/api"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/engine"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/runtime"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	addr := envOr("PROCESS_SIM_ADDR", "127.0.0.1:7700")
	maxInstances, err := strconv.Atoi(envOr("PROCESS_SIM_MAX_INSTANCES", "256"))
	if err != nil || maxInstances < 1 {
		log.Error("PROCESS_SIM_MAX_INSTANCES must be a positive whole number")
		os.Exit(2)
	}

	maxDevices, err := strconv.Atoi(envOr("PROCESS_SIM_MAX_DEVICES", "2048"))
	if err != nil || maxDevices < 1 {
		log.Error("PROCESS_SIM_MAX_DEVICES must be a positive whole number")
		os.Exit(2)
	}

	processes := engine.New(log, maxInstances)
	devices := runtime.New(log, maxDevices, device.Options{})
	server, err := api.New(processes, devices, os.Getenv("PROCESS_SIM_TOKEN"), log)
	if err != nil {
		log.Error("refusing to start", "error", err.Error())
		os.Exit(2)
	}
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Info("process-sim listening", "addr", addr, "version", api.Version, "contractVersion", engine.ContractVersion, "deviceContractVersion", device.ContractVersion, "maxInstances", maxInstances, "maxDevices", maxDevices, "profiles", device.Profiles())
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped", "error", err.Error())
			os.Exit(1)
		}
	}()
	<-ctx.Done()

	// Instances live in memory only: a restart starts empty and Z-Factory loads them again.
	log.Info("shutting down")
	processes.Shutdown()
	devices.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
