# The Z-Factory process simulation service (ADR-0008, TASK-602): one container that hosts
# many process-module instances. Built as a static binary and run from a distroless image
# as a non-root user with no shell; the compose file adds the resource limits.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 GOFLAGS=-trimpath go build -ldflags="-s -w -X github.com/sakibcoolz/z-factory/services/process-sim/internal/api.Version=${VERSION}" -o /process-sim ./cmd/process-sim

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /process-sim /process-sim
USER nonroot:nonroot
EXPOSE 7700
ENV PROCESS_SIM_ADDR=0.0.0.0:7700
ENTRYPOINT ["/process-sim"]
