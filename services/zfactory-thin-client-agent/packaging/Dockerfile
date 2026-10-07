# The Thin Client Agent as a container (TASK-906, docs/edge-deployment.md). The image
# carries the same checksummed binary as the systemd package: build it first with
# packaging/build.sh, then, from services/zfactory-thin-client-agent:
#
#   docker build -f packaging/Dockerfile --build-arg VERSION=<version> -t zfactory-agent:<version> .
#   docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 ...   (multi-arch)
#
# Distroless static, non-root (65532), no shell. State lives in /var/lib/zfactory-agent
# (staging/, active/, rejected/, spool/): mount a volume there. The health check asks the
# agent at ZFACTORY_AGENT_HEALTH_ADDR, so it follows a changed address. Secrets (the MQTT password
# file, the broker CA) are mounted read-only, never baked into the image.
# The state directory, owned by the agent's user: a new named volume takes it over.
FROM busybox:1.37 AS state
RUN mkdir -p /out/var/lib/zfactory-agent && chown -R 65532:65532 /out/var/lib/zfactory-agent && chmod 0750 /out/var/lib/zfactory-agent

FROM gcr.io/distroless/static-debian12:nonroot

ARG VERSION
ARG TARGETARCH
ARG TARGETVARIANT
COPY --from=state /out/ /
COPY --chmod=0555 dist/zfactory-agent-${VERSION}-linux-${TARGETARCH}${TARGETVARIANT} /usr/local/bin/zfactory-agent

ENV ZFACTORY_AGENT_DIR=/var/lib/zfactory-agent \
    ZFACTORY_AGENT_HEALTH_ADDR=0.0.0.0:9180
VOLUME ["/var/lib/zfactory-agent"]
EXPOSE 9180
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/zfactory-agent", "-probe"]
ENTRYPOINT ["/usr/local/bin/zfactory-agent"]
LABEL org.opencontainers.image.title="Z-Factory Thin Client Agent" \
      org.opencontainers.image.version="${VERSION}"
