# Run WTS on an x86_64 host

The container runs the Rust `wtsd` binary and serves the compiled React
interface. It is useful for a headless x86 Linux machine or a browser-only WTS
installation.

For a developer laptop, prefer WTS Desktop. A container cannot open host
VS Code, supervise processes outside the container, or discover repositories
that were not explicitly mounted.

## Build and run on the x86 box

```bash
docker compose up -d --build
docker compose ps
```

On that same Linux host, open `http://127.0.0.1:3000/`.

Change the published port if needed:

```bash
WTS_PORT=8080 docker compose up -d --build
```

## Build an amd64 image elsewhere

```bash
docker buildx build \
  --platform linux/amd64 \
  --tag wts:0.1.0-amd64 \
  --output type=docker,dest=wts-0.1.0-amd64.tar \
  .
gzip wts-0.1.0-amd64.tar
```

Transfer the archive and `compose.yaml`, then on the x86 host:

```bash
gunzip wts-0.1.0-amd64.tar.gz
docker load --input wts-0.1.0-amd64.tar
docker compose up -d --no-build
```

## Repository access

Bind only the repository parent directories WTS should control:

```yaml
services:
  wtsd:
    environment:
      WTS_REPOSITORY_ROOT: /repositories
    volumes:
      - wts-data:/data
      - /srv/repositories:/repositories
```

The container runs as UID/GID `10001:10001`. Grant that identity the required
access with ownership or host ACLs. Do not make repositories world-writable.

All repository paths and process commands are container-local. If a project
needs Node, Java, databases, or another toolchain, extend the runtime image or
run it through an explicitly configured companion container.

## Operations

```bash
docker compose ps
docker compose logs -f wtsd
docker compose restart wtsd
docker compose down
```

Stopping Compose does not delete the named `wts-data` volume.

## Exposure

`wtsd` hard-fails on non-loopback listeners. The Linux Compose file therefore
uses host networking and binds only `127.0.0.1`. It is not a remote multi-user
deployment. Do not expose WTS directly to the public internet. Remote access
would require a separately designed authentication and TLS boundary and is not
part of the local product.
