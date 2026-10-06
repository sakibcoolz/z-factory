// Command zfactory-agent is the Z-Factory Thin Client Agent (TASK-503,
// docs/thin-client-agent.md): it runs the PLCs deployed in its directory and serves its
// state on a local health endpoint.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/agent"
)

// version is set at build time: -ldflags "-X main.version=…".
var version = "dev"

func env(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(env(name, strconv.Itoa(fallback)))
	if err != nil {
		return fallback
	}
	return value
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(env(name, fallback.String()))
	if err != nil {
		return fallback
	}
	return value
}

func main() {
	dir := flag.String("dir", env("ZFACTORY_AGENT_DIR", "/etc/zfactory-agent"), "directory with staging/, active/, rejected/ and spool/")
	healthAddr := flag.String("health", env("ZFACTORY_AGENT_HEALTH_ADDR", "127.0.0.1:9180"), "address of the local health endpoint")
	scan := flag.Duration("scan", envDuration("ZFACTORY_AGENT_SCAN_INTERVAL", 2*time.Second), "how often staging/ and active/ are scanned")
	settle := flag.Duration("settle", envDuration("ZFACTORY_AGENT_SETTLE", time.Second), "how old a staging file must be before it is read")
	polls := flag.Int("max-concurrent-polls", envInt("ZFACTORY_AGENT_MAX_CONCURRENT_POLLS", 64), "polls in flight across all PLCs")
	queue := flag.Int("queue", envInt("ZFACTORY_AGENT_QUEUE", 10_000), "telemetry batches held for the uplink")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	running, err := agent.Start(ctx, agent.Settings{
		Dir:                *dir,
		HealthAddr:         *healthAddr,
		ScanInterval:       *scan,
		Settle:             *settle,
		QueueCapacity:      *queue,
		MaxConcurrentPolls: *polls,
		Version:            version,
		Logger:             log,
	})
	if err != nil {
		log.Error("agent did not start", "error", err.Error())
		os.Exit(1)
	}
	<-ctx.Done()
	if err := running.Stop(); err != nil {
		log.Error("agent did not stop cleanly", "error", err.Error())
		os.Exit(1)
	}
}
