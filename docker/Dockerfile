############################################
# Healthcheck Binary
############################################
FROM louislam/dockge:build-healthcheck AS build_healthcheck

############################################
# Build
############################################
FROM louislam/dockge:base AS build
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
RUN npm ci --omit=dev

############################################
# ⭐ Main Image
############################################
FROM louislam/dockge:base AS release
WORKDIR /app

# docker compose pinned to v5.0.2. From v5.1.0 compose parses the networks returned by the daemon strictly and fails
# when a network has an IPv6 gateway written with its prefix ("fd..::1/64"), as the Docker daemon of TrueNAS SCALE
# returns it: ParseAddr("...::1/64"): unexpected character, want colon. v5.0.2 is the last release that reads it.
# The official binary replaces the plugin of the base image, after checking its SHA-256.
ARG TARGETARCH
ARG TARGETVARIANT
RUN set -eux; \
    case "${TARGETARCH}${TARGETVARIANT}" in \
        amd64) arch=x86_64; sum=2d880f723d3da7c779c54fdaea91a842fca8af55d1397f1ed8d7cbab3dd7af67 ;; \
        arm64) arch=aarch64; sum=ac7810e0cd56a5b58576688196fafa843e07e8241fb91018a736d549ea20a3f3 ;; \
        armv7) arch=armv7; sum=d9a0742638f15bd91598ce465cca8718490d967cfb1a28305c388f214d09976b ;; \
        *) echo "Unsupported architecture ${TARGETARCH}${TARGETVARIANT}"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/v5.0.2/docker-compose-linux-${arch}"; \
    echo "${sum}  /tmp/docker-compose" | sha256sum -c -; \
    install -m 0755 /tmp/docker-compose /usr/libexec/docker/cli-plugins/docker-compose; \
    rm /tmp/docker-compose; \
    docker compose version
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck
COPY --from=build /app/node_modules /app/node_modules
COPY --chown=node:node  . .
RUN mkdir ./data


# It is just for safe, as by default, it is disabled in the latest Node.js now.
# Read more:
# - https://github.com/sagemathinc/cocalc/issues/6963
# - https://github.com/microsoft/node-pty/issues/630#issuecomment-1987212447
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "./backend/index.ts"]

############################################
# Mark as Nightly
############################################
FROM release AS nightly
RUN npm run mark-as-nightly
