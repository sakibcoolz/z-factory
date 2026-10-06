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
	"strings"
	"syscall"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/agent"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/uplink"
)

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "agent"
	}
	// Topic segments take letters, digits, _ and - only.
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
			return r
		}
		return '-'
	}, name)
}

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
	broker := flag.String("mqtt-url", env("ZFACTORY_AGENT_MQTT_URL", ""), "MQTT broker, e.g. mqtts://broker:8883; empty runs without an uplink")
	siteID := flag.String("site-id", env("ZFACTORY_AGENT_SITE_ID", ""), "site id in the MQTT topics")
	agentID := flag.String("agent-id", env("ZFACTORY_AGENT_ID", hostname()), "agent id in the MQTT topics")
	clientID := flag.String("mqtt-client-id", env("ZFACTORY_AGENT_MQTT_CLIENT_ID", ""), "MQTT client id (default zfactory-agent-<site>-<agent>)")
	username := flag.String("mqtt-username", env("ZFACTORY_AGENT_MQTT_USERNAME", ""), "MQTT user name")
	passwordFile := flag.String("mqtt-password-file", env("ZFACTORY_AGENT_MQTT_PASSWORD_FILE", ""), "file holding the MQTT password")
	caFile := flag.String("mqtt-ca-file", env("ZFACTORY_AGENT_MQTT_CA_FILE", ""), "CA certificate of the broker (PEM)")
	certFile := flag.String("mqtt-cert-file", env("ZFACTORY_AGENT_MQTT_CERT_FILE", ""), "client certificate (PEM)")
	keyFile := flag.String("mqtt-key-file", env("ZFACTORY_AGENT_MQTT_KEY_FILE", ""), "client key (PEM)")
	qos := flag.Int("mqtt-telemetry-qos", envInt("ZFACTORY_AGENT_MQTT_TELEMETRY_QOS", 1), "QoS of telemetry (0 or 1)")
	publishers := flag.Int("mqtt-publishers", envInt("ZFACTORY_AGENT_MQTT_PUBLISHERS", 4), "telemetry publishers shared by all PLCs")
	heartbeat := flag.Duration("heartbeat", envDuration("ZFACTORY_AGENT_HEARTBEAT", 10*time.Second), "heartbeat interval")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var link *uplink.Settings
	if *broker != "" {
		link = &uplink.Settings{
			BrokerURL: *broker, ClientID: *clientID, SiteID: *siteID, AgentID: *agentID,
			Username: *username, PasswordFile: *passwordFile, CAFile: *caFile, CertFile: *certFile, KeyFile: *keyFile,
			TelemetryQoS: byte(min(max(*qos, 0), 1)), Publishers: *publishers, Heartbeat: *heartbeat,
		}
	}
	running, err := agent.Start(ctx, agent.Settings{
		Dir:                *dir,
		HealthAddr:         *healthAddr,
		ScanInterval:       *scan,
		Settle:             *settle,
		QueueCapacity:      *queue,
		MaxConcurrentPolls: *polls,
		Version:            version,
		Logger:             log,
		Uplink:             link,
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
