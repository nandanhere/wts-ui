# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22
ARG RUST_VERSION=1.95

FROM node:${NODE_VERSION}-bookworm-slim AS ui-builder
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM rust:${RUST_VERSION}-bookworm AS rust-builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY src-tauri/ ./src-tauri/
RUN cargo build --release --locked -p wts-server

FROM debian:bookworm-slim AS runtime
WORKDIR /app

ENV WTS_ADDR=127.0.0.1:3000
ENV WTS_UI_DIR=/app/ui
ENV WTS_DATA_DIR=/data
ENV WTS_WORKSPACE_ROOT=/data/workspaces
ENV WTS_REPOSITORY_ROOT=/repositories
ENV RUST_LOG=wts_server=info,tower_http=info

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 wts \
    && useradd --uid 10001 --gid 10001 --home-dir /data --create-home wts \
    && mkdir -p /app/ui /data/workspaces /repositories \
    && chown -R wts:wts /app /data /repositories

COPY --from=rust-builder --chown=wts:wts /build/target/release/wtsd /usr/local/bin/wtsd
COPY --from=ui-builder --chown=wts:wts /build/ui/dist /app/ui

USER wts

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:3000/api/health"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/wtsd"]
